/// <reference lib="webworker" />
import { isobands } from '@turf/turf';
import { Engine, GRID, metres } from './engine';
import { lineColour, lineLabel } from './lines';
import type {
  ComputeResult, Leg, ProbeResult, RawNetwork, RouteOptions,
  RouteResult, StationHit, StationRef,
} from './types';

let engine: Engine | null = null;
let lineMeta: RawNetwork['lines'] = {};

/** Upper bound of the time slider; routing runs to here once and is then reused. */
const ROUTE_HORIZON = 120;

/** Cache the Dijkstra pass: only the grid depends on the time slider. */
let cache: { key: string; route: RouteResult } | null = null;
/** Last options seen, so a hover probe uses the same walk caps as the drawing. */
let lastOpt: RouteOptions | null = null;

/** Pick a round band interval giving roughly 3-6 bands. */
function niceBreaks(maxTime: number): number[] {
  const steps = [1, 2, 3, 5, 10, 15, 20, 30];
  const step =
    steps.find((s) => maxTime % s === 0 && maxTime / s <= 6 && maxTime / s >= 3) ??
    steps.find((s) => maxTime / s <= 6) ??
    30;
  const breaks = [0];
  for (let t = step; t < maxTime - 1e-9; t += step) breaks.push(t);
  breaks.push(maxTime);
  return breaks;
}

/** The URL is passed in: a worker's own base is /assets/, not the page's. */
async function init(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load network.json (${res.status})`);
  const net: RawNetwork = await res.json();
  engine = new Engine(net);
  lineMeta = net.lines;

  const stations: StationRef[] = engine.names.map((name, i) => ({
    name,
    lat: engine!.lat[i],
    lon: engine!.lon[i],
    modes: engine!.stationModes[i],
  }));

  postMessage({
    type: 'ready',
    generated: net.generated,
    source: net.source,
    stations,
    lineCount: Object.keys(net.lines).length,
  });
}

function compute(id: number, origin: { lat: number; lon: number }, opt: RouteOptions) {
  if (!engine) return;
  const started = performance.now();

  // Route once out to the slider's maximum, so moving the slider only re-rasterises.
  const key = JSON.stringify([
    origin.lat, origin.lon, opt.walkSpeed, opt.maxAccessWalk,
    opt.transferPenalty, opt.serviceFactor, opt.modes,
  ]);
  const route = cache?.key === key
    ? cache.route
    : engine.route(origin.lat, origin.lon, { ...opt, maxTime: ROUTE_HORIZON });
  cache = { key, route };
  lastOpt = opt;
  const arrival = route.arrival;

  const grid = engine.timeGrid(origin.lat, origin.lon, arrival, opt);

  // turf.isobands consumes a regular lattice of points carrying a z value.
  const features: GeoJSON.Feature[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const lat = GRID.minLat + r * grid.latStep;
    for (let c = 0; c < grid.cols; c++) {
      features.push({
        type: 'Feature',
        properties: { z: grid.values[r * grid.cols + c] },
        geometry: { type: 'Point', coordinates: [GRID.minLon + c * grid.lonStep, lat] },
      });
    }
  }

  const breaks = niceBreaks(opt.maxTime);
  let bands: GeoJSON.FeatureCollection;
  try {
    bands = isobands(
      { type: 'FeatureCollection', features } as never,
      breaks,
      { zProperty: 'z' } as never,
    ) as unknown as GeoJSON.FeatureCollection;
  } catch {
    bands = { type: 'FeatureCollection', features: [] };
  }

  // Tag each band with its rank so the map colours by magnitude, not label text.
  const bandCount = bands.features.length;
  bands.features.forEach((f, i) => {
    f.properties = {
      ...f.properties,
      band: i, bandCount,
      from: breaks[i], to: breaks[i + 1] ?? opt.maxTime,
    };
  });
  // Draw the smallest, darkest band last so it sits on top of the wider ones.
  bands.features.reverse();

  // One interchange can be several TfL records (Wimbledon is tube + rail + tram).
  // Routing needs them separate; the list and the map dots do not.
  const byName = new Map<string, StationHit>();
  for (let s = 0; s < arrival.length; s++) {
    if (arrival[s] >= opt.maxTime) continue;
    const name = engine.names[s];
    const hit: StationHit = {
      name,
      lat: engine.lat[s],
      lon: engine.lon[s],
      t: Math.round(arrival[s] * 10) / 10,
      mode: engine.stationModes[s][0] ?? 'tube',
    };
    const prev = byName.get(name);
    // Only merge if they really are the same place, not a coincidence of naming.
    if (prev && metres(prev.lat, prev.lon, hit.lat, hit.lon) < 600) {
      if (hit.t < prev.t) byName.set(name, hit);
    } else if (!prev) {
      byName.set(name, hit);
    }
  }
  const stations = [...byName.values()].sort((a, b) => a.t - b.t);

  // Measure area from the raster, not the bands: isobands can nest polygons,
  // which would double-count the overlap.
  const cellKm2 = (GRID.cellMetres / 1000) ** 2;
  let reachedCells = 0;
  for (let i = 0; i < grid.values.length; i++) if (grid.values[i] <= opt.maxTime) reachedCells++;
  const areaKm2 = reachedCells * cellKm2;

  const result: ComputeResult = {
    id,
    bands,
    breaks,
    stations,
    stats: {
      areaKm2: Math.round(areaKm2),
      stationCount: stations.length,
      ms: Math.round(performance.now() - started),
    },
  };
  postMessage({ type: 'result', ...result });
}

/** Resolve a hovered point into a renderable itinerary. Runs on every mouse move. */
function probe(id: number, lat: number, lon: number) {
  if (!engine || !cache || !lastOpt) return;
  const raw = engine.probe(lat, lon, cache.route, lastOpt);

  let journey: ProbeResult['journey'] = null;
  if (raw) {
    const legs: Leg[] = raw.legs.map((l) => {
      if (l.kind === 'walk') return l;
      const id = engine!.lineIds[l.line];
      const meta = lineMeta[id];
      const mode = meta?.mode ?? 'tube';
      const shared = {
        lineName: lineLabel(meta?.name ?? id, mode),
        mode,
        colour: lineColour(id, mode),
      };
      return l.kind === 'wait'
        ? { kind: 'wait', minutes: l.minutes, at: l.at, ...shared }
        : { kind: 'ride', minutes: l.minutes, stops: l.stops, from: l.from, to: l.to, ...shared };
    });
    journey = { total: raw.total, reachable: raw.reachable, legs };
  }

  const result: ProbeResult = { id, journey };
  postMessage({ type: 'probe', ...result });
}

onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      init(msg.url).catch((e) => postMessage({ type: 'error', message: String(e.message ?? e) }));
    }
    else if (msg.type === 'compute') compute(msg.id, msg.origin, msg.opt);
    else if (msg.type === 'probe') probe(msg.id, msg.lat, msg.lon);
  } catch (e) {
    postMessage({ type: 'error', message: String((e as Error).message ?? e) });
  }
};
