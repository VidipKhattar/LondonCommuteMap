import type { RawNetwork, RouteOptions } from './types';

// London-wide grid, padded so walk circles near the edge aren't clipped.
export const GRID = {
  minLat: 51.19, maxLat: 51.79,
  minLon: -0.66, maxLon: 0.43,
  cellMetres: 250,
};

const M_PER_LAT = 111_320;
const M_PER_LON = 111_320 * Math.cos((51.5 * Math.PI) / 180);
const UNREACHABLE = 1e6;

interface Adj { to: number; line: number; t: number }

export class Engine {
  readonly names: string[] = [];
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly stationModes: string[][] = [];
  readonly generated: string;

  private out: Adj[][] = [];
  private transfers: { to: number; t: number }[][] = [];
  private lineMode: string[] = [];
  private lineHeadway: number[] = [];

  /** Lat/lon buckets over the station set, for "stations near a point" queries. */
  private bucket = new Map<string, number[]>();
  private readonly bucketDeg = 0.01;

  constructor(net: RawNetwork) {
    this.generated = net.generated;
    const n = net.stations.length;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);

    const idx = new Map<string, number>();
    net.stations.forEach((s, i) => {
      idx.set(s.id, i);
      this.names.push(s.n);
      this.lat[i] = s.lat;
      this.lon[i] = s.lon;
      this.stationModes.push(s.m);
      this.out.push([]);
      this.transfers.push([]);
      const key = this.bucketKey(s.lat, s.lon);
      const list = this.bucket.get(key);
      if (list) list.push(i); else this.bucket.set(key, [i]);
    });

    const lineIdx = new Map<string, number>();
    for (const [id, meta] of Object.entries(net.lines)) {
      lineIdx.set(id, this.lineMode.length);
      this.lineMode.push(meta.mode);
      this.lineHeadway.push(meta.headway);
    }

    // Ride edges, both directions (TfL sequences don't always cover both).
    for (const e of net.edges) {
      const a = idx.get(e.a), b = idx.get(e.b), l = lineIdx.get(e.l);
      if (a === undefined || b === undefined || l === undefined) continue;
      this.addRide(a, b, l, e.t);
      this.addRide(b, a, l, e.t);
    }

    for (const t of net.transfers) {
      const a = idx.get(t.a), b = idx.get(t.b);
      if (a === undefined || b === undefined) continue;
      this.transfers[a].push({ to: b, t: t.t });
      this.transfers[b].push({ to: a, t: t.t });
    }
  }

  private addRide(a: number, b: number, line: number, t: number) {
    const existing = this.out[a].find((x) => x.to === b && x.line === line);
    if (existing) { existing.t = Math.min(existing.t, t); return; }
    this.out[a].push({ to: b, line, t });
  }

  private bucketKey(lat: number, lon: number) {
    return `${Math.floor(lat / this.bucketDeg)}:${Math.floor(lon / this.bucketDeg)}`;
  }

  stationsNear(lat: number, lon: number, radiusM: number): number[] {
    // A degree of longitude is shorter than one of latitude, so the two axes need
    // different bucket spans — sharing one under-covers longitude at big radii.
    const spanLat = Math.ceil(radiusM / M_PER_LAT / this.bucketDeg) + 1;
    const spanLon = Math.ceil(radiusM / M_PER_LON / this.bucketDeg) + 1;
    const bLat = Math.floor(lat / this.bucketDeg);
    const bLon = Math.floor(lon / this.bucketDeg);
    const hits: number[] = [];
    for (let dy = -spanLat; dy <= spanLat; dy++) {
      for (let dx = -spanLon; dx <= spanLon; dx++) {
        const list = this.bucket.get(`${bLat + dy}:${bLon + dx}`);
        if (!list) continue;
        for (const i of list) {
          if (metres(lat, lon, this.lat[i], this.lon[i]) <= radiusM) hits.push(i);
        }
      }
    }
    return hits;
  }

  /**
   * Earliest arrival time (minutes) at every station, from a point on the map.
   *
   * Dijkstra over (station, arriving line) states so that staying on a line is
   * free while changing costs a penalty plus the wait for the next service.
   */
  route(originLat: number, originLon: number, opt: RouteOptions): Float32Array {
    const nStations = this.names.length;
    const nLines = this.lineMode.length;
    const slots = nLines + 1;             // last slot = arrived on foot
    const walkSlot = nLines;
    const mPerMin = (opt.walkSpeed * 1000) / 60;

    const allowed = new Uint8Array(nLines);
    for (let l = 0; l < nLines; l++) allowed[l] = opt.modes.includes(this.lineMode[l]) ? 1 : 0;

    const wait = new Float32Array(nLines);
    for (let l = 0; l < nLines; l++) {
      wait[l] = Math.min(12, (this.lineHeadway[l] * opt.serviceFactor) / 2);
    }

    const dist = new Float32Array(nStations * slots).fill(UNREACHABLE);
    const heap = new MinHeap();

    // Seed: walk from the origin to every station within reach.
    for (const s of this.stationsNear(originLat, originLon, opt.maxAccessWalk * mPerMin)) {
      const w = metres(originLat, originLon, this.lat[s], this.lon[s]) / mPerMin;
      if (w >= opt.maxTime) continue;
      const key = s * slots + walkSlot;
      if (w < dist[key]) { dist[key] = w; heap.push(w, key); }
    }

    while (heap.size) {
      const key = heap.pop()!;
      const cost = heap.lastValue;
      if (cost > dist[key] + 1e-6) continue;
      const station = (key / slots) | 0;
      const from = key % slots;
      if (cost >= opt.maxTime) continue;

      for (const e of this.out[station]) {
        if (!allowed[e.line]) continue;
        let board = 0;
        if (from !== e.line) {
          board = wait[e.line] + (from === walkSlot ? 0 : opt.transferPenalty);
        }
        const next = cost + board + e.t;
        if (next >= opt.maxTime) continue;
        const nk = e.to * slots + e.line;
        if (next < dist[nk]) { dist[nk] = next; heap.push(next, nk); }
      }

      // Out-of-station interchange (Bank <-> Monument, Euston <-> Euston Square...).
      if (from !== walkSlot) {
        for (const tr of this.transfers[station]) {
          const next = cost + tr.t * (4.8 / opt.walkSpeed);
          if (next >= opt.maxTime) continue;
          const nk = tr.to * slots + walkSlot;
          if (next < dist[nk]) { dist[nk] = next; heap.push(next, nk); }
        }
      }
    }

    // Collapse (station, line) states down to one arrival time per station.
    const best = new Float32Array(nStations).fill(UNREACHABLE);
    for (let s = 0; s < nStations; s++) {
      let m = UNREACHABLE;
      for (let l = 0; l < slots; l++) {
        const v = dist[s * slots + l];
        if (v < m) m = v;
      }
      best[s] = m;
    }
    return best;
  }

  /**
   * Rasterises door-to-door travel time over London.
   *
   * Each reachable station stamps a walking disc onto the grid, keeping the
   * minimum — which is exactly the multi-source shortest walk from any station.
   * The origin stamps its own disc so short trips on foot are covered too.
   */
  timeGrid(originLat: number, originLon: number, arrival: Float32Array, opt: RouteOptions) {
    const latStep = GRID.cellMetres / M_PER_LAT;
    const lonStep = GRID.cellMetres / M_PER_LON;
    const rows = Math.ceil((GRID.maxLat - GRID.minLat) / latStep);
    const cols = Math.ceil((GRID.maxLon - GRID.minLon) / lonStep);
    const values = new Float32Array(rows * cols).fill(UNREACHABLE);
    const mPerMin = (opt.walkSpeed * 1000) / 60;

    const stamp = (lat: number, lon: number, base: number, walkBudget: number) => {
      if (walkBudget <= 0) return;
      const radiusM = walkBudget * mPerMin;
      const r0 = Math.max(0, Math.floor((lat - radiusM / M_PER_LAT - GRID.minLat) / latStep));
      const r1 = Math.min(rows - 1, Math.ceil((lat + radiusM / M_PER_LAT - GRID.minLat) / latStep));
      const c0 = Math.max(0, Math.floor((lon - radiusM / M_PER_LON - GRID.minLon) / lonStep));
      const c1 = Math.min(cols - 1, Math.ceil((lon + radiusM / M_PER_LON - GRID.minLon) / lonStep));
      for (let r = r0; r <= r1; r++) {
        const cellLat = GRID.minLat + r * latStep;
        const dy = (cellLat - lat) * M_PER_LAT;
        for (let c = c0; c <= c1; c++) {
          const dx = (GRID.minLon + c * lonStep - lon) * M_PER_LON;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > radiusM) continue;
          const t = base + d / mPerMin;
          const i = r * cols + c;
          if (t < values[i]) values[i] = t;
        }
      }
    };

    // Pure walking from the door, capped so huge budgets don't imply a hike.
    stamp(originLat, originLon, 0, Math.min(opt.maxTime, 45));

    for (let s = 0; s < arrival.length; s++) {
      const a = arrival[s];
      if (a >= opt.maxTime) continue;
      stamp(this.lat[s], this.lon[s], a, Math.min(opt.maxEgressWalk, opt.maxTime - a));
    }

    return { values, rows, cols, latStep, lonStep };
  }
}

export function metres(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dy = (bLat - aLat) * M_PER_LAT;
  const dx = (bLon - aLon) * M_PER_LON;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Binary heap keyed on cost; `lastValue` exposes the cost of the last pop/push. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  lastValue = 0;

  get size() { return this.keys.length; }

  push(value: number, key: number) {
    this.keys.push(key);
    this.vals.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number | undefined {
    if (!this.keys.length) return undefined;
    const key = this.keys[0];
    this.lastValue = this.vals[0];
    const lastKey = this.keys.pop()!;
    const lastVal = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.vals.length && this.vals[l] < this.vals[m]) m = l;
        if (r < this.vals.length && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return key;
  }

  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}

export { UNREACHABLE };
