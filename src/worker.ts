/// <reference lib="webworker" />
import { isobands } from '@turf/turf';
import { Engine, GRID, metres } from './engine';
import { lineColour, lineLabel } from './lines';
import type {
  ComputeResult, DestInput, Journey, LayerResult, Leg, ProbeJourney, ProbeResult,
  RawNetwork, RouteOptions, RouteResult, StationHit, StationRef,
} from './types';

let engine: Engine | null = null;
let lineMeta: RawNetwork['lines'] = {};

/** Upper bound of the time slider; routing runs to here once and is then reused. */
const ROUTE_HORIZON = 120;

/**
 * Cached Dijkstra pass per place, keyed on that place's id: moving one pin or
 * adding a place leaves the others' routing untouched. Only the grid depends on
 * the time slider.
 */
const routes = new Map<number, { key: string; route: RouteResult }>();
/** Last options and places seen, so a hover probe matches what's drawn. */
let lastOpt: RouteOptions | null = null;
let lastDests: DestInput[] = [];

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

interface GridMeta { rows: number; cols: number; latStep: number; lonStep: number }

/** Turn a raster of travel times into bands ranked fastest to slowest. */
function toBands(
  values: Float32Array, meta: GridMeta, breaks: number[], maxTime: number,
): GeoJSON.FeatureCollection {
  // turf.isobands consumes a regular lattice of points carrying a z value.
  const features: GeoJSON.Feature[] = [];
  for (let r = 0; r < meta.rows; r++) {
    const lat = GRID.minLat + r * meta.latStep;
    for (let c = 0; c < meta.cols; c++) {
      features.push({
        type: 'Feature',
        properties: { z: values[r * meta.cols + c] },
        geometry: { type: 'Point', coordinates: [GRID.minLon + c * meta.lonStep, lat] },
      });
    }
  }

  let bands: GeoJSON.FeatureCollection;
  try {
    bands = isobands(
      { type: 'FeatureCollection', features } as never,
      breaks,
      { zProperty: 'z' } as never,
    ) as unknown as GeoJSON.FeatureCollection;
  } catch {
    return { type: 'FeatureCollection', features: [] };
  }

  // Tag each band with its rank so the map colours by magnitude, not label text.
  const bandCount = bands.features.length;
  bands.features.forEach((f, i) => {
    f.properties = {
      ...f.properties,
      band: i, bandCount,
      from: breaks[i], to: breaks[i + 1] ?? maxTime,
    };
  });
  // Draw the smallest, darkest band last so it sits on top of the wider ones.
  bands.features.reverse();
  return bands;
}

/**
 * Measure area from the raster, not the bands: isobands can nest polygons,
 * which would double-count the overlap.
 */
function areaOf(values: Float32Array, maxTime: number): number {
  const cellKm2 = (GRID.cellMetres / 1000) ** 2;
  let reached = 0;
  for (let i = 0; i < values.length; i++) if (values[i] <= maxTime) reached++;
  return Math.round(reached * cellKm2);
}

function stationHits(arrival: Float32Array, maxTime: number): StationHit[] {
  // One interchange can be several TfL records (Wimbledon is tube + rail + tram).
  // Routing needs them separate; the list and the map dots do not.
  const byName = new Map<string, StationHit>();
  for (let s = 0; s < arrival.length; s++) {
    if (arrival[s] >= maxTime) continue;
    const name = engine!.names[s];
    const hit: StationHit = {
      name,
      lat: engine!.lat[s],
      lon: engine!.lon[s],
      t: Math.round(arrival[s] * 10) / 10,
      mode: engine!.stationModes[s][0] ?? 'tube',
    };
    const prev = byName.get(name);
    // Only merge if they really are the same place, not a coincidence of naming.
    if (prev && metres(prev.lat, prev.lon, hit.lat, hit.lon) < 600) {
      if (hit.t < prev.t) byName.set(name, hit);
    } else if (!prev) {
      byName.set(name, hit);
    }
  }
  return [...byName.values()].sort((a, b) => a.t - b.t);
}

/** Everything about a place's routing that isn't the time slider. */
function routeKey(d: DestInput, opt: RouteOptions) {
  return JSON.stringify([
    d.lat, d.lon, opt.walkSpeed, opt.maxAccessWalk,
    opt.transferPenalty, opt.serviceFactor, opt.modes,
  ]);
}

function compute(id: number, dests: DestInput[], opt: RouteOptions) {
  if (!engine || !dests.length) return;
  const started = performance.now();

  // Forget places that have since been removed, so their routing isn't kept alive.
  const live = new Set(dests.map((d) => d.key));
  for (const key of [...routes.keys()]) if (!live.has(key)) routes.delete(key);

  const breaks = niceBreaks(opt.maxTime);
  const layers: LayerResult[] = [];
  let meta: GridMeta | null = null;
  // Worst commute of the set, per cell — what the overlap band is measured on.
  let worst: Float32Array | null = null;

  for (const d of dests) {
    const key = routeKey(d, opt);
    const hit = routes.get(d.key);
    const route = hit?.key === key
      ? hit.route
      : engine.route(d.lat, d.lon, { ...opt, maxTime: ROUTE_HORIZON });
    routes.set(d.key, { key, route });

    const grid = engine.timeGrid(d.lat, d.lon, route.arrival, opt);
    meta = grid;

    layers.push({
      key: d.key,
      bands: toBands(grid.values, grid, breaks, opt.maxTime),
      stations: stationHits(route.arrival, opt.maxTime),
      areaKm2: areaOf(grid.values, opt.maxTime),
    });

    if (dests.length > 1) {
      if (!worst) worst = Float32Array.from(grid.values);
      else for (let i = 0; i < worst.length; i++) worst[i] = Math.max(worst[i], grid.values[i]);
    }
  }

  const overlap = worst && meta
    ? { bands: toBands(worst, meta, breaks, opt.maxTime), areaKm2: areaOf(worst, opt.maxTime) }
    : null;

  lastOpt = opt;
  lastDests = dests;

  const result: ComputeResult = {
    id, breaks, layers, overlap, ms: Math.round(performance.now() - started),
  };
  postMessage({ type: 'result', ...result });
}

/** Resolve line slots into the names, modes and colours the card renders. */
function renderable(raw: Journey | null): ProbeJourney['journey'] {
  if (!raw) return null;
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
  return { total: raw.total, reachable: raw.reachable, legs };
}

/**
 * Resolve a hovered point into one itinerary per place. Runs on every mouse
 * move, so it reuses the routing already cached for the drawing.
 */
function probe(id: number, lat: number, lon: number) {
  if (!engine || !lastOpt) return;

  const journeys: ProbeJourney[] = [];
  for (const d of lastDests) {
    const cached = routes.get(d.key);
    if (!cached) continue;
    journeys.push({
      key: d.key,
      journey: renderable(engine.probe(lat, lon, cached.route, lastOpt)),
    });
  }

  const result: ProbeResult = { id, journeys };
  postMessage({ type: 'probe', ...result });
}

onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      init(msg.url).catch((e) => postMessage({ type: 'error', message: String(e.message ?? e) }));
    }
    else if (msg.type === 'compute') compute(msg.id, msg.dests, msg.opt);
    else if (msg.type === 'probe') probe(msg.id, msg.lat, msg.lon);
  } catch (e) {
    postMessage({ type: 'error', message: String((e as Error).message ?? e) });
  }
};
