import type { StationRef } from './types';

export interface Place {
  label: string;
  detail: string;
  lat: number;
  lon: number;
  kind: 'station' | 'postcode' | 'address';
}

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const PARTIAL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}$/i;

const LONDON_VIEWBOX = '-0.58,51.73,0.36,51.24';

/** Rank station names by how well they match what's been typed. */
function matchStations(query: string, stations: StationRef[]): Place[] {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!q) return [];

  // One interchange can be several TfL stations (Stratford is tube + DLR + rail +
  // Elizabeth line). Group by name so the list shows it once, with all its modes.
  const groups = new Map<string, { s: StationRef; modes: Set<string>; score: number }>();

  for (const s of stations) {
    const name = s.name.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.split(' ').some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 3;
    else continue;

    const existing = groups.get(name);
    if (existing) {
      for (const m of s.modes) existing.modes.add(m);
    } else {
      groups.set(name, { s, modes: new Set(s.modes), score: score * 100 + name.length });
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)
    .map(({ s, modes }) => ({
      label: s.name,
      detail: [...modes].map(prettyMode).join(' · '),
      lat: s.lat, lon: s.lon, kind: 'station' as const,
    }));
}

export function prettyMode(m: string) {
  return ({
    tube: 'Tube', dlr: 'DLR', overground: 'Overground',
    'elizabeth-line': 'Elizabeth line', tram: 'Tram', 'national-rail': 'National Rail',
  } as Record<string, string>)[m] ?? m;
}

async function lookupPostcode(query: string): Promise<Place[]> {
  const q = query.trim();
  if (POSTCODE.test(q)) {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const { result } = await res.json();
    if (!result) return [];
    return [{
      label: result.postcode,
      detail: [result.parish || result.admin_ward, result.admin_district].filter(Boolean).join(', '),
      lat: result.latitude, lon: result.longitude, kind: 'postcode',
    }];
  }
  // Partial postcode -> autocomplete then resolve the top few.
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}/autocomplete`);
  if (!res.ok) return [];
  const { result } = await res.json();
  if (!Array.isArray(result) || !result.length) return [];
  const bulk = await fetch('https://api.postcodes.io/postcodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postcodes: result.slice(0, 4) }),
  });
  if (!bulk.ok) return [];
  const data = await bulk.json();
  return (data.result ?? [])
    .filter((r: { result: unknown }) => r.result)
    .map((r: { result: Record<string, string | number> }) => ({
      label: r.result.postcode as string,
      detail: [r.result.admin_ward, r.result.admin_district].filter(Boolean).join(', '),
      lat: r.result.latitude as number,
      lon: r.result.longitude as number,
      kind: 'postcode' as const,
    }));
}

async function lookupAddress(query: string): Promise<Place[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'gb');
  url.searchParams.set('viewbox', LONDON_VIEWBOX);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const rows = await res.json();
  return (rows as Record<string, never>[]).map((r) => {
    const parts = String(r.display_name).split(', ');
    return {
      label: parts[0] + (parts[1] && !/^\d/.test(parts[1]) ? `, ${parts[1]}` : ''),
      detail: parts.slice(1, 4).join(', '),
      lat: parseFloat(r.lat as unknown as string),
      lon: parseFloat(r.lon as unknown as string),
      kind: 'address' as const,
    };
  });
}

/**
 * Suggestions for the search box. Station matches come back instantly from the
 * bundled network; postcode and address lookups hit the network and arrive after.
 */
export async function suggest(query: string, stations: StationRef[]): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const local = matchStations(q, stations);
  const remote: Promise<Place[]>[] = [];

  if (PARTIAL_POSTCODE.test(q)) remote.push(lookupPostcode(q).catch(() => []));
  if (q.length >= 4 && /[a-z]{3}/i.test(q)) remote.push(lookupAddress(q).catch(() => []));

  const settled = (await Promise.all(remote)).flat();

  // Postcodes first when the query looks like one, otherwise stations lead.
  const looksPostcode = PARTIAL_POSTCODE.test(q) && /\d/.test(q);
  const merged = looksPostcode ? [...settled, ...local] : [...local, ...settled];

  // Drop repeats by coordinate and by label — Nominatim often echoes a station name.
  const seen = new Set<string>();
  return merged.filter((p) => {
    const keys = [`@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, `#${p.label.toLowerCase()}`];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  }).slice(0, 8);
}
