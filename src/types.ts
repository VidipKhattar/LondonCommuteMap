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

export interface ComputeResult {
  id: number;
  bands: GeoJSON.FeatureCollection;
  breaks: number[];
  stations: StationHit[];
  stats: { areaKm2: number; stationCount: number; ms: number };
}

export interface StationRef {
  name: string;
  lat: number;
  lon: number;
  modes: string[];
}
