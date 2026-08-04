export interface RawNetwork {
  generated: string;
  source: string;
  lines: Record<string, { name: string; mode: string; headway: number }>;
  stations: { id: string; n: string; lat: number; lon: number; m: string[]; l: string[]; z: string | null }[];
  edges: { a: string; b: string; l: string; t: number }[];
  transfers: { a: string; b: string; t: number }[];
}

export interface RouteOptions {
  /** Minutes of travel the isochrone covers. */
  maxTime: number;
  /** Walking speed, km/h. */
  walkSpeed: number;
  /** Longest walk from the origin to a first station, minutes. */
  maxAccessWalk: number;
  /** Longest walk from a station to the final destination, minutes. */
  maxEgressWalk: number;
  /** Flat cost of changing lines, on top of waiting for the next service. */
  transferPenalty: number;
  /** Multiplies each line's headway: 1 = peak service, higher = quieter. */
  serviceFactor: number;
  /** TfL modes the traveller is willing to use. */
  modes: string[];
}

export interface StationHit {
  name: string;
  lat: number;
  lon: number;
  /** Minutes from the origin, door to platform. */
  t: number;
  mode: string;
}

/** One place the commuter travels to, as the worker needs it. */
export interface DestInput {
  /** Stable id, so the worker can keep each place's routing cached separately. */
  key: number;
  lat: number;
  lon: number;
}

/** The isochrone for a single place. */
export interface LayerResult {
  key: number;
  bands: GeoJSON.FeatureCollection;
  stations: StationHit[];
  areaKm2: number;
}

export interface ComputeResult {
  id: number;
  breaks: number[];
  layers: LayerResult[];
  /**
   * Where every place is in range at once, banded on the *worst* commute of the
   * set — so a point inside the 40 minute band is within 40 minutes of them all.
   * Null while there is only one place.
   */
  overlap: { bands: GeoJSON.FeatureCollection; areaKm2: number } | null;
  ms: number;
}

export interface StationRef {
  name: string;
  lat: number;
  lon: number;
  modes: string[];
}

/** Everything the router produces, including what's needed to replay a journey. */
export interface RouteResult {
  /** Earliest arrival in minutes, per station. */
  arrival: Float32Array;
  /** Cost per (station, line) state. */
  dist: Float32Array;
  /** Predecessor state per state; -1 at a seed. */
  prev: Int32Array;
  /** The winning state per station. */
  bestState: Int32Array;
  slots: number;
  walkSlot: number;
  origin: { lat: number; lon: number };
}

/** A journey leg as the engine emits it, with lines still as slot indices. */
export type RawLeg =
  | { kind: 'walk'; minutes: number; from: string | null; to: string | null }
  | { kind: 'wait'; minutes: number; line: number; at: string }
  | { kind: 'ride'; minutes: number; line: number; from: string; to: string; stops: number };

export interface Journey {
  total: number;
  reachable: boolean;
  legs: RawLeg[];
}

/** A leg ready to render: line slots resolved to names, modes and colours. */
export type Leg =
  | { kind: 'walk'; minutes: number; from: string | null; to: string | null }
  | { kind: 'wait'; minutes: number; at: string; lineName: string; mode: string; colour: string }
  | {
      kind: 'ride'; minutes: number; stops: number;
      from: string; to: string;
      lineName: string; mode: string; colour: string;
    };

/** One hovered-point-to-place answer; a null journey means it can't be reached. */
export interface ProbeJourney {
  key: number;
  journey: { total: number; reachable: boolean; legs: Leg[] } | null;
}

export interface ProbeResult {
  id: number;
  journeys: ProbeJourney[];
}
