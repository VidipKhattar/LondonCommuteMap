#!/usr/bin/env node
/**
 * Builds public/network.json: the London public-transport graph.
 *
 * Data comes from the open TfL Unified API (no key needed at this volume):
 *   /Line/Mode/{mode}/Route              -> which lines exist
 *   /Line/{id}/Route/Sequence/{dir}      -> station order + coordinates per branch
 *   /Line/{id}/Timetable/{stopId}        -> real scheduled minutes between stations
 *
 * Hop times are taken from the timetable where TfL publishes one, and fall back
 * to a distance/speed estimate where it doesn't (mostly National Rail).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'network.json');

// Greater London-ish. National Rail lines run far beyond the city; clip them.
const BOUNDS = { minLat: 51.24, maxLat: 51.73, minLon: -0.58, maxLon: 0.36 };

const MODES = ['tube', 'dlr', 'overground', 'elizabeth-line', 'tram', 'national-rail'];

// TfL only publishes timetables for these modes; the rest 400/return empty.
const TIMETABLED_MODES = new Set(['tube', 'dlr', 'tram']);

// Straight-line speed (km/h) used when no timetable exists, plus per-stop dwell.
// Calibrated against real journeys, e.g. Paddington->Abbey Wood (Elizabeth, 29 min),
// Richmond->Stratford (Mildmay, ~50 min), Waterloo->Surbiton (SWR, ~18 min).
const FALLBACK_SPEED = {
  tube: 33, dlr: 30, overground: 30, 'elizabeth-line': 55, tram: 20, 'national-rail': 55,
};

// Typical weekday-daytime headway in minutes. Expected wait = headway / 2.
const HEADWAY = {
  bakerloo: 4, central: 3, circle: 8, district: 4, 'hammersmith-city': 8,
  jubilee: 3, metropolitan: 6, northern: 3, piccadilly: 3, victoria: 2,
  'waterloo-city': 4, dlr: 5, elizabeth: 5, tram: 7,
  liberty: 30, lioness: 15, mildmay: 8, suffragette: 15, weaver: 10, windrush: 8,
};
const DEFAULT_HEADWAY = { 'national-rail': 15, overground: 12, tube: 5, dlr: 5, tram: 7, 'elizabeth-line': 5 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function api(path) {
  const url = `https://api.tfl.gov.uk${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(150); // stay well inside TfL's rate limit
    calls++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'LondonCommuteMap/1.0' } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      if (attempt === 3) {
        console.warn(`  ! giving up on ${path}: ${err.message}`);
        return null;
      }
      await sleep(1200 * (attempt + 1));
    }
  }
  return null;
}

const inBounds = (lat, lon) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon;

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** TfL suffixes every name with "Underground Station" etc. Strip the noise. */
function cleanName(name) {
  return name
    .replace(/\s+(Underground|Rail|DLR|Tram)\s+Station$/i, '')
    .replace(/\s+Station$/i, '')
    .replace(/\s+\(London\)$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------

const stations = new Map(); // id -> { id, name, lat, lon, modes:Set, lines:Set, zone }
const hopSamples = new Map(); // "a|b|line" -> minutes[]
const adjacency = new Map(); // "a|b|line" -> { a, b, line, mode }

function addStation(sp, mode) {
  const id = sp.stationId || sp.id;
  if (!id || typeof sp.lat !== 'number' || !inBounds(sp.lat, sp.lon)) return null;
  let st = stations.get(id);
  if (!st) {
    st = {
      id, name: cleanName(sp.name || id), lat: sp.lat, lon: sp.lon,
      modes: new Set(), lines: new Set(),
      zone: sp.zone ? String(sp.zone).split('+')[0] : null,
    };
    stations.set(id, st);
  }
  st.modes.add(mode);
  return st;
}

async function collectLine(lineId, mode) {
  const termini = new Set();
  let branches = 0;

  for (const dir of ['inbound', 'outbound']) {
    const seq = await api(`/Line/${lineId}/Route/Sequence/${dir}?serviceTypes=Regular`);
    if (!seq?.stopPointSequences) continue;

    for (const branch of seq.stopPointSequences) {
      const stops = (branch.stopPoint || [])
        .map((sp) => ({ sp, st: addStation(sp, mode) }))
        .filter((x) => x.st);
      if (stops.length < 2) continue;
      branches++;
      termini.add(stops[0].st.id);

      for (const { st } of stops) st.lines.add(lineId);

      for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1].st, b = stops[i].st;
        if (a.id === b.id) continue;
        const key = `${a.id}|${b.id}|${lineId}`;
        if (!adjacency.has(key)) adjacency.set(key, { a: a.id, b: b.id, line: lineId, mode });
      }
    }
  }
  return { termini: [...termini], branches };
}

/** Pull real inter-station minutes by differencing cumulative timetable arrivals. */
async function collectTimings(lineId, termini) {
  let found = 0;
  for (const stopId of termini.slice(0, 8)) {
    const tt = await api(`/Line/${lineId}/Timetable/${stopId}`);
    const routes = tt?.timetable?.routes;
    if (!routes) continue;

    for (const route of routes) {
      for (const si of route.stationIntervals || []) {
        let prevId = stopId, prevTime = 0;
        for (const iv of si.intervals || []) {
          const t = iv.timeToArrival;
          if (typeof t !== 'number' || !iv.stopId) { prevId = iv.stopId; continue; }
          const delta = t - prevTime;
          if (prevId && prevId !== iv.stopId && delta > 0 && delta < 45) {
            for (const key of [`${prevId}|${iv.stopId}|${lineId}`, `${iv.stopId}|${prevId}|${lineId}`]) {
              if (!adjacency.has(key)) continue;
              if (!hopSamples.has(key)) hopSamples.set(key, []);
              hopSamples.get(key).push(delta);
              found++;
            }
          }
          prevId = iv.stopId;
          prevTime = t;
        }
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------

async function main() {
  const lineModes = new Map();

  for (const mode of MODES) {
    const lines = await api(`/Line/Mode/${mode}/Route`);
    if (!lines) { console.warn(`no lines for ${mode}`); continue; }
    console.log(`\n${mode}: ${lines.length} line(s)`);

    for (const line of lines) {
      lineModes.set(line.id, { mode, name: line.name });
      const { termini, branches } = await collectLine(line.id, mode);
      if (!branches) { console.log(`  ${line.id}: no stops in London, skipped`); continue; }
      const timed = TIMETABLED_MODES.has(mode) ? await collectTimings(line.id, termini) : 0;
      const note = TIMETABLED_MODES.has(mode) ? `${timed} timed hops` : 'no TfL timetable, estimating';
      console.log(`  ${line.id}: ${branches} branch(es), ${termini.length} termini, ${note}`);
    }
  }

  // Resolve every adjacency to a duration: median of timetable samples, else distance.
  const edges = [];
  let estimated = 0;
  for (const [key, edge] of adjacency) {
    const from = stations.get(edge.a), to = stations.get(edge.b);
    if (!from || !to) continue;
    const km = haversineKm(from.lat, from.lon, to.lat, to.lon);

    let minutes;
    const samples = hopSamples.get(key);
    if (samples?.length) {
      const sorted = [...samples].sort((x, y) => x - y);
      minutes = sorted[Math.floor(sorted.length / 2)];
    } else {
      minutes = (km / FALLBACK_SPEED[edge.mode]) * 60 + 0.5; // + dwell
      estimated++;
    }
    edges.push({
      a: edge.a, b: edge.b, l: edge.line,
      t: Math.round(Math.max(0.6, minutes) * 10) / 10,
    });
  }

  // Walking interchanges between distinct nearby stations (e.g. Bank <-> Monument).
  const list = [...stations.values()];
  const transfers = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const km = haversineKm(list[i].lat, list[i].lon, list[j].lat, list[j].lon);
      if (km > 0.45) continue;
      transfers.push({ a: list[i].id, b: list[j].id, t: Math.round((km / 4.8) * 60 * 10) / 10 + 1 });
    }
  }

  const lines = {};
  for (const [id, meta] of lineModes) {
    if (![...stations.values()].some((s) => s.lines.has(id))) continue;
    lines[id] = {
      name: meta.name,
      mode: meta.mode,
      headway: HEADWAY[id] ?? DEFAULT_HEADWAY[meta.mode] ?? 10,
    };
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'TfL Unified API (Powered by TfL Open Data)',
    lines,
    stations: list.map((s) => ({
      id: s.id, n: s.name,
      lat: Math.round(s.lat * 1e5) / 1e5, lon: Math.round(s.lon * 1e5) / 1e5,
      m: [...s.modes], l: [...s.lines], z: s.zone,
    })),
    edges,
    transfers,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);

  console.log(`\n${'='.repeat(58)}`);
  console.log(`stations : ${out.stations.length}`);
  console.log(`lines    : ${Object.keys(lines).length}`);
  console.log(`edges    : ${edges.length}  (${edges.length - estimated} timetabled, ${estimated} estimated)`);
  console.log(`transfers: ${transfers.length}`);
  console.log(`written  : public/network.json (${kb} KB, ${calls} API calls)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
