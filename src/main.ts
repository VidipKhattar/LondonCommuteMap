import L from 'leaflet';
import './style.css';
import { suggest, prettyMode, type Place } from './geocode';
import { ensureContrast, isPale, legIcon } from './lines';
import type {
  ComputeResult, LayerResult, Leg, ProbeResult, RouteOptions, StationHit, StationRef,
} from './types';

const MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'national-rail', 'tram'] as const;
const SERVICE_LABELS = ['Peak', 'Off-peak', 'Evening'];
const SERVICE_FACTORS = [1, 1.5, 2.5];

/** Each extra place costs a full routing pass and its own isoband run. */
const MAX_PLACES = 5;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  search: $<HTMLInputElement>('search'),
  clear: $<HTMLButtonElement>('clear'),
  suggestions: $<HTMLUListElement>('suggestions'),
  places: $<HTMLUListElement>('places'),
  addPlace: $<HTMLButtonElement>('add-place'),
  originNote: $('origin-note'),
  viewField: $('view-field'),
  view: $('view'),
  viewNote: $('view-note'),
  time: $<HTMLInputElement>('time'),
  timeOut: $('time-out'),
  modes: $('modes'),
  service: $<HTMLInputElement>('service'),
  serviceOut: $('service-out'),
  walk: $<HTMLInputElement>('walk'),
  walkOut: $('walk-out'),
  walkHome: $<HTMLInputElement>('walk-home'),
  walkHomeOut: $('walk-home-out'),
  walkDest: $<HTMLInputElement>('walk-dest'),
  walkDestOut: $('walk-dest-out'),
  change: $<HTMLInputElement>('change'),
  changeOut: $('change-out'),
  showStations: $<HTMLInputElement>('show-stations'),
  legend: $('legend'),
  stats: $('stats'),
  stationList: $<HTMLOListElement>('station-list'),
  stationFor: $('station-for'),
  stationCount: $('station-count'),
  toast: $('toast'),
  hoverCard: $('hover-card'),
  built: $('built'),
  panel: $('panel'),
  panelToggle: $<HTMLButtonElement>('panel-toggle'),
};

const isDark = matchMedia('(prefers-color-scheme: dark)').matches;

// ------------------------------------------------------------- colour

/**
 * One hue per place, each with a sequential ramp over it. Hues are spread far
 * enough apart that their blends where areas overlap stay distinguishable.
 */
interface Palette {
  name: string;
  hue: number;
  sat: number;
  /** Lightness at the fastest and slowest band, on a light then a dark surface. */
  onLight?: [number, number];
  onDark?: [number, number];
}

const PALETTES: Palette[] = [
  { name: 'Blue', hue: 212, sat: 68 },
  { name: 'Coral', hue: 8, sat: 72 },
  { name: 'Green', hue: 148, sat: 52 },
  { name: 'Violet', hue: 282, sat: 48 },
  { name: 'Amber', hue: 36, sat: 78 },
];

/**
 * The overlap layer is drawn on its own, so a near-neutral ink keeps it from
 * reading as any one place's colour. It needs a wider lightness range than the
 * hues do to carry the same weight against the basemap.
 */
const OVERLAP_PALETTE: Palette = {
  name: 'All places', hue: 225, sat: 13,
  onLight: [15, 80], onDark: [93, 30],
};

/**
 * Band `i` of `n`, fastest first. On a light surface the fastest band carries
 * the most ink and later bands recede toward the page; against near-black the
 * brightest step is the salient one, so the ramp runs the other way.
 */
function rampColor(p: Palette, i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const [from, to] = (isDark ? p.onDark : p.onLight) ?? (isDark ? [88, 36] : [26, 78]);
  return `hsl(${p.hue} ${p.sat}% ${(from + t * (to - from)).toFixed(1)}%)`;
}

/** The place's identity colour: pin, list dot, legend swatch. */
function keyColor(p: Palette): string {
  return `hsl(${p.hue} ${Math.min(92, p.sat + 6)}% ${isDark ? 62 : 44}%)`;
}

// ----------------------------------------------------------------- state

interface Spot {
  /** Stable across edits, so the worker can cache this place's routing. */
  key: number;
  lat: number;
  lon: number;
  label: string;
  /** Index into PALETTES — held for the place's whole life, so its colour never
   *  shifts when another place is removed. */
  palette: number;
  marker: L.Marker;
}

let spots: Spot[] = [];
let activeKey = 0;
let nextKey = 1;
/** True while the next search pick or map click should create a place. */
let adding = false;

let stationRefs: StationRef[] = [];
let ready = false;
let requestId = 0;
let inFlight = false;
let pending = false;

const active = () => spots.find((s) => s.key === activeKey) ?? spots[0];
const overlapView = () =>
  spots.length > 1 &&
  el.view.querySelector<HTMLInputElement>('input[value="overlap"]')!.checked;

// ------------------------------------------------------------------- map

const map = L.map('map', {
  center: [51.5074, -0.1278], // central London
  zoom: 11,
  zoomControl: true,
  minZoom: 8,
  maxZoom: 18,
  preferCanvas: true,
});

// Bands from isobands nest rather than tile, so painting them individually
// translucent stacks their alpha and washes the ramp out. Instead each band is
// opaque and the whole pane is composited once — the topmost band wins per pixel.
// One pane per palette slot, so places blend against each other, not within.
for (let i = 0; i < MAX_PLACES; i++) {
  const pane = map.createPane(`iso-${i}`);
  pane.style.zIndex = String(250 + i);
  pane.style.pointerEvents = 'none';
}
const overlapPane = map.createPane('iso-overlap');
overlapPane.style.zIndex = String(250 + MAX_PLACES);
overlapPane.style.pointerEvents = 'none';

// Above the station dots (overlayPane, 400) so place names stay legible.
map.createPane('labels').style.zIndex = '450';
map.getPane('labels')!.style.pointerEvents = 'none';

L.tileLayer(
  isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a> | Powered by TfL Open Data',
  },
).addTo(map);

function bandLayer(pane: string, palette: () => Palette) {
  const renderer = L.canvas({ pane });
  return L.geoJSON(undefined, {
    pane,
    style: (f) => {
      const colour = rampColor(
        palette(),
        (f?.properties?.band as number) ?? 0,
        (f?.properties?.bandCount as number) ?? 1,
      );
      return {
        renderer,
        color: colour, weight: 0,
        fillColor: colour, fillOpacity: 1,
        interactive: false,
      };
    },
  }).addTo(map);
}

/** One band layer per palette slot, reused as places come and go. */
const isoLayers = Array.from({ length: MAX_PLACES }, (_, i) =>
  bandLayer(`iso-${i}`, () => PALETTES[i]));
const overlapLayer = bandLayer('iso-overlap', () => OVERLAP_PALETTE);

// Street labels ride above the isochrones so the map stays readable.
L.tileLayer(
  isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  { subdomains: 'abcd', maxZoom: 20, pane: 'labels' },
).addTo(map);

const stationLayer = L.layerGroup().addTo(map);

map.on('click', (e: L.LeafletMouseEvent) => {
  if (adding) addSpot(e.latlng.lat, e.latlng.lng, 'Pinned location');
  else if (active()) moveSpot(activeKey, e.latlng.lat, e.latlng.lng, 'Pinned location');
});

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#2a78d6';
}

// ---------------------------------------------------------------- worker

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;

  if (msg.type === 'ready') {
    stationRefs = msg.stations;
    ready = true;
    el.built.textContent =
      `${msg.stations.length} stations · ${msg.lineCount} lines · network snapshot ` +
      new Date(msg.generated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    toast('');
    schedule();
    return;
  }

  if (msg.type === 'error') {
    toast(`Error: ${msg.message}`, true);
    inFlight = false;
    return;
  }

  if (msg.type === 'result') {
    inFlight = false;
    if (msg.id === requestId) render(msg as ComputeResult);
    if (pending) { pending = false; schedule(); }
    return;
  }

  if (msg.type === 'probe') {
    probeInFlight = false;
    if (msg.id === probeId) drawHoverCard(msg as ProbeResult);
    if (probePending) { const p = probePending; probePending = null; requestProbe(p.lat, p.lon); }
  }
};

worker.postMessage({ type: 'init', url: new URL('network.json', document.baseURI).href });
toast('Loading the London network…');

// ------------------------------------------------------------- controls

function options(): RouteOptions {
  return {
    maxTime: +el.time.value,
    walkSpeed: +el.walk.value,
    // The router works outward from each chosen place, so its access walk is the
    // one at that end and its egress walk is the commuter's home end.
    maxAccessWalk: +el.walkDest.value,
    maxEgressWalk: +el.walkHome.value,
    transferPenalty: +el.change.value,
    serviceFactor: SERVICE_FACTORS[+el.service.value - 1],
    modes: MODES.filter((m) => ($(`mode-${m}`) as HTMLInputElement | null)?.checked),
  };
}

function schedule() {
  if (!ready || !spots.length) return;
  if (inFlight) { pending = true; return; }
  inFlight = true;
  requestId++;
  worker.postMessage({
    type: 'compute',
    id: requestId,
    dests: spots.map((s) => ({ key: s.key, lat: s.lat, lon: s.lon })),
    opt: options(),
  });
}

el.modes.innerHTML = MODES.map((m) => `
  <label class="chip">
    <input type="checkbox" id="mode-${m}" checked />
    <span class="dot"></span>${prettyMode(m)}
  </label>`).join('');

const syncLabels = () => {
  el.timeOut.textContent = `${el.time.value} min`;
  el.serviceOut.textContent = SERVICE_LABELS[+el.service.value - 1];
  el.walkOut.textContent = `${(+el.walk.value).toFixed(1)} km/h`;
  el.walkHomeOut.textContent = `${el.walkHome.value} min`;
  el.walkDestOut.textContent = `${el.walkDest.value} min`;
  el.changeOut.textContent = `${el.change.value} min`;
};
syncLabels();

for (const input of [el.time, el.service, el.walk, el.walkHome, el.walkDest, el.change]) {
  input.addEventListener('input', () => { syncLabels(); schedule(); });
}
el.modes.addEventListener('change', schedule);
el.showStations.addEventListener('change', () => drawStations());
el.view.addEventListener('change', () => { applyView(); drawLegend(); drawStations(); });

const isNarrow = () => matchMedia('(max-width: 820px)').matches;

function setPanelCollapsed(collapsed: boolean) {
  el.panel.dataset.collapsed = String(collapsed);
  el.panelToggle.textContent = collapsed ? 'Controls' : 'Hide';
}

// On a phone the map is the point — start with it uncovered.
if (isNarrow()) setPanelCollapsed(true);

el.panelToggle.addEventListener('click', () => {
  setPanelCollapsed(el.panel.dataset.collapsed !== 'true');
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
  b.addEventListener('click', () => {
    el.search.value = b.dataset.example!;
    runSuggest(true);
  });
}

// -------------------------------------------------------------- places

function pinIcon(s: Spot) {
  const colour = keyColor(PALETTES[s.palette]);
  const cls = s.key === activeKey ? 'place-pin is-active' : 'place-pin';
  // The number ties the pin to its row in the panel and to its number key.
  const n = spots.length > 1 ? placeIndex(s.key) : '';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="--pin:${colour}">${n}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function addSpot(lat: number, lon: number, label: string, recentre = false) {
  if (spots.length >= MAX_PLACES) { toast(`That's the limit of ${MAX_PLACES} places.`); return; }

  const used = new Set(spots.map((s) => s.palette));
  const palette = PALETTES.findIndex((_, i) => !used.has(i));

  const marker = L.marker([lat, lon], { draggable: true, zIndexOffset: 1000 });
  const spot: Spot = { key: nextKey++, lat, lon, label, palette, marker };

  marker.on('dragstart', hideHover);
  marker.on('dragend', () => {
    const { lat: la, lng: lo } = marker.getLatLng();
    moveSpot(spot.key, la, lo, 'Pinned location');
  });
  marker.on('click', (e) => { L.DomEvent.stop(e); setActive(spot.key); });
  marker.addTo(map);

  spots.push(spot);
  adding = false;
  activeKey = spot.key;
  if (recentre) fitPending = true;
  renderPlaces();
  schedule();
}

function removeSpot(key: number) {
  const spot = spots.find((s) => s.key === key);
  if (!spot || spots.length === 1) return;
  map.removeLayer(spot.marker);
  isoLayers[spot.palette].clearLayers();
  stationsByKey.delete(key);
  areaByKey.delete(key);
  spots = spots.filter((s) => s.key !== key);
  if (activeKey === key) activeKey = spots[0].key;
  renderPlaces();
  schedule();
}

function moveSpot(key: number, lat: number, lon: number, label: string, recentre = false) {
  const spot = spots.find((s) => s.key === key);
  if (!spot) return;
  Object.assign(spot, { lat, lon, label });
  spot.marker.setLatLng([lat, lon]);
  if (recentre) fitPending = true;
  renderPlaces();
  schedule();
}

function setActive(key: number) {
  if (activeKey === key) return;
  activeKey = key;
  adding = false;
  renderPlaces();
  drawStations();
  drawStats();
  // The hovered point hasn't changed, so the card can re-render from the last
  // probe — no round trip, and the route swaps under a stationary cursor.
  if (!el.hoverCard.hidden && lastProbe) drawHoverCard(lastProbe);
}

/**
 * Number keys swap which place the hover card details. Clicking the panel works
 * too, but not without leaving the map and losing the point you were reading.
 */
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const i = Number(e.key) - 1;
  if (Number.isInteger(i) && i >= 0 && i < spots.length) {
    e.preventDefault();
    setActive(spots[i].key);
  }
});

/** Places are numbered by list position, which is what the number keys match. */
const placeIndex = (key: number) => spots.findIndex((s) => s.key === key) + 1;

/** Redraw the list, the pins, and everything that names the active place. */
function renderPlaces() {
  el.places.innerHTML = spots.map((s, i) => `
    <li class="place${s.key === activeKey ? ' is-active' : ''}" data-key="${s.key}">
      <span class="pl-dot" style="background:${keyColor(PALETTES[s.palette])}"></span>
      <span class="pl-label">${escapeHtml(s.label)}</span>
      ${spots.length > 1 ? `<kbd class="pl-key">${i + 1}</kbd>` : ''}
      ${spots.length > 1
        ? `<button class="pl-remove" type="button" data-remove="${s.key}"
                   aria-label="Remove ${escapeHtml(s.label)}">&times;</button>`
        : ''}
    </li>`).join('');

  for (const s of spots) s.marker.setIcon(pinIcon(s));

  el.addPlace.disabled = spots.length >= MAX_PLACES;
  el.addPlace.textContent = adding ? 'Cancel' : '+ Add another place';
  el.addPlace.classList.toggle('is-adding', adding);

  el.viewField.hidden = spots.length < 2;

  const a = active();
  if (adding) {
    el.search.value = '';
    el.search.placeholder = 'Search a place to add…';
    el.originNote.textContent = 'Search above, or click the map, to drop the new place.';
  } else if (a) {
    el.search.value = a.label;
    el.search.placeholder = 'Postcode, station or address';
    el.originNote.textContent =
      `${a.label} · ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} — drag its pin, or click the map, to move it.`;
  }
  el.clear.hidden = !el.search.value;

  el.stationFor.textContent = a && spots.length > 1 ? ` · ${a.label}` : '';
  applyView();
}

el.places.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const remove = target.closest<HTMLButtonElement>('[data-remove]');
  if (remove) { removeSpot(+remove.dataset.remove!); return; }
  const li = target.closest<HTMLLIElement>('.place');
  if (li) setActive(+li.dataset.key!);
});

el.addPlace.addEventListener('click', () => {
  adding = !adding;
  renderPlaces();
  if (adding) el.search.focus();
});

/** Show either every place's own bands, or just where they all overlap. */
function applyView() {
  const overlap = overlapView();
  const shown = new Set(spots.map((s) => s.palette));

  el.viewNote.textContent = overlap
    ? `Shaded by the longest of your commutes: inside the ${el.time.value} min band is `
      + `within ${el.time.value} min of every place.`
    : 'Each place in its own colour; the colours mix where they overlap.';

  for (let i = 0; i < MAX_PLACES; i++) {
    const pane = map.getPane(`iso-${i}`)!;
    pane.style.display = !overlap && shown.has(i) ? '' : 'none';
    // Several translucent panes stacked would just wash out, so overlapping
    // places are composited: darker where they meet on white, brighter on black.
    pane.style.mixBlendMode = spots.length > 1 ? (isDark ? 'screen' : 'multiply') : 'normal';
    pane.style.opacity = spots.length > 1 ? (isDark ? '0.62' : '0.58') : '0.62';
  }
  overlapPane.style.display = overlap ? '' : 'none';
  overlapPane.style.opacity = '0.72';
}

// -------------------------------------------------------------- search

let suggestTimer: number | undefined;
let activeIndex = -1;
let currentPlaces: Place[] = [];

function closeSuggestions() {
  el.suggestions.hidden = true;
  el.suggestions.innerHTML = '';
  activeIndex = -1;
  currentPlaces = [];
}

function showSuggestions(places: Place[], autoPick: boolean) {
  currentPlaces = places;
  if (!places.length) { closeSuggestions(); return; }
  if (autoPick) { choose(places[0]); return; }

  el.suggestions.innerHTML = places.map((p, i) => `
    <li role="option" data-i="${i}" aria-selected="${i === 0}">
      <span class="sg-label">${escapeHtml(p.label)}</span>
      <span class="sg-detail">${escapeHtml(p.detail || p.kind)}</span>
    </li>`).join('');
  el.suggestions.hidden = false;
  activeIndex = 0;
}

el.suggestions.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  e.preventDefault();
  choose(currentPlaces[+li.dataset.i!]);
});

async function runSuggest(autoPick = false) {
  const q = el.search.value.trim();
  el.clear.hidden = !q;
  if (q.length < 2) { closeSuggestions(); return; }
  const places = await suggest(q, stationRefs);
  // Ignore results that arrived after the user kept typing.
  if (el.search.value.trim() !== q) return;
  showSuggestions(places, autoPick);
}

el.search.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => runSuggest(), 220) as unknown as number;
});

el.search.addEventListener('keydown', (e) => {
  const items = el.suggestions.querySelectorAll('li');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.setAttribute('aria-selected', String(i === activeIndex)));
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIndex >= 0 && currentPlaces[activeIndex]) choose(currentPlaces[activeIndex]);
    else runSuggest(true);
  } else if (e.key === 'Escape') {
    closeSuggestions();
    if (adding) { adding = false; renderPlaces(); }
  }
});

el.search.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

el.clear.addEventListener('click', () => {
  el.search.value = '';
  el.clear.hidden = true;
  closeSuggestions();
  el.search.focus();
});

/** A picked suggestion either becomes a new place, or moves the active one. */
function choose(p: Place) {
  closeSuggestions();
  // Hand focus back to the page: otherwise the number keys that switch the
  // hovered route would type into the search box instead.
  el.search.blur();
  // Picking a place frames its reachable area; dragging a pin or moving a
  // slider leaves the view alone, which would otherwise be jarring.
  if (adding) addSpot(p.lat, p.lon, p.label, true);
  else moveSpot(activeKey, p.lat, p.lon, p.label, true);
}

// -------------------------------------------------------------- render

const stationsByKey = new Map<number, StationHit[]>();
const areaByKey = new Map<number, number>();
let lastBreaks: number[] = [];
let overlapArea: number | null = null;
let fitPending = false;

function render(res: ComputeResult) {
  lastBreaks = res.breaks;

  const byKey = new Map<number, LayerResult>(res.layers.map((l) => [l.key, l]));
  for (const s of spots) {
    const layer = isoLayers[s.palette];
    layer.clearLayers();
    const data = byKey.get(s.key);
    if (!data) continue;
    if (data.bands.features.length) layer.addData(data.bands as never);
    stationsByKey.set(s.key, data.stations);
    areaByKey.set(s.key, data.areaKm2);
  }

  overlapLayer.clearLayers();
  overlapArea = res.overlap?.areaKm2 ?? null;
  if (res.overlap?.bands.features.length) overlapLayer.addData(res.overlap.bands as never);

  applyView();

  if (fitPending) {
    fitPending = false;
    const bounds = spots.reduce(
      (acc, s) => { const b = isoLayers[s.palette].getBounds(); return b.isValid() ? acc.extend(b) : acc; },
      L.latLngBounds([]),
    );
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13, animate: true });
    } else if (active()) {
      map.setView([active().lat, active().lon], 12, { animate: true });
    }
  }

  drawLegend();
  drawStations();
  drawStats();

  const a = active();
  const list = (a && stationsByKey.get(a.key)) ?? [];
  el.stationCount.textContent = list.length ? `(${list.length})` : '';
  el.stationList.innerHTML = list.slice(0, 300).map((s, i) => `
    <li data-i="${i}">
      <span>${escapeHtml(s.name)}</span>
      <span class="sm">${prettyMode(s.mode)}</span>
      <span class="t">${Math.round(s.t)}m</span>
    </li>`).join('') || '<li class="sm" style="cursor:default">No stations within this time.</li>';

  toast(`Computed in ${res.ms} ms`);
  setTimeout(() => toast(''), 1400);
}

el.stationList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li?.dataset.i) return;
  const a = active();
  const s = a && stationsByKey.get(a.key)?.[+li.dataset.i];
  if (s) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 14), { animate: true });
});

function bandFor(t: number, breaks: number[]) {
  for (let i = 1; i < breaks.length; i++) if (t <= breaks[i]) return i - 1;
  return breaks.length - 2;
}

/** Dots for the active place only — every place's stations at once is a mess. */
function drawStations() {
  stationLayer.clearLayers();
  const a = active();
  if (!el.showStations.checked || !a || overlapView()) return;

  const stations = stationsByKey.get(a.key) ?? [];
  const bandCount = Math.max(1, lastBreaks.length - 1);
  const palette = PALETTES[a.palette];

  for (const s of stations) {
    L.circleMarker([s.lat, s.lon], {
      radius: 4,
      color: cssVar('--dot-stroke'),
      weight: 1.2,
      fillColor: rampColor(palette, bandFor(s.t, lastBreaks), bandCount),
      fillOpacity: 1,
    })
      .bindTooltip(`${escapeHtml(s.name)} · <b>${Math.round(s.t)} min</b>`, {
        className: 'stn', direction: 'top', offset: [0, -6],
      })
      .addTo(stationLayer);
  }
}

function rampBar(p: Palette, n: number) {
  return `<div class="legend-bar">${
    Array.from({ length: n }, (_, i) => `<span style="background:${rampColor(p, i, n)}"></span>`).join('')
  }</div>`;
}

function drawLegend() {
  const breaks = lastBreaks;
  if (breaks.length < 2) { el.legend.innerHTML = ''; return; }
  const n = breaks.length - 1;
  const labels = `<div class="legend-labels">${breaks.map((b) => `<span>${b}</span>`).join('')}</div>`;

  const bars = overlapView() || spots.length === 1
    ? rampBar(overlapView() ? OVERLAP_PALETTE : PALETTES[active()?.palette ?? 0], n)
    : spots.map((s) => `
        <div class="legend-row">
          <span class="lg-name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
          ${rampBar(PALETTES[s.palette], n)}
        </div>`).join('');

  el.legend.innerHTML = bars + labels +
    `<div class="legend-labels"><span>${
      overlapView() ? 'minutes to the furthest of your places' : 'minutes door to door'
    }</span></div>`;
}

function drawStats() {
  const a = active();
  if (spots.length === 1) {
    el.stats.innerHTML = `
      <div class="stat"><div class="v">${(areaByKey.get(spots[0].key) ?? 0).toLocaleString()}</div><div class="k">km² in range</div></div>
      <div class="stat"><div class="v">${stationsByKey.get(spots[0].key)?.length ?? 0}</div><div class="k">stations</div></div>`;
    return;
  }

  const tiles = spots.map((s) => `
    <div class="stat${s.key === a?.key ? ' is-active' : ''}">
      <div class="v">${(areaByKey.get(s.key) ?? 0).toLocaleString()}</div>
      <div class="k"><span class="pl-dot" style="background:${keyColor(PALETTES[s.palette])}"></span>${escapeHtml(s.label)}</div>
    </div>`);

  if (overlapArea !== null) {
    tiles.push(`
      <div class="stat stat-overlap">
        <div class="v">${overlapArea.toLocaleString()}</div>
        <div class="k">km² in range of ${spots.length === 2 ? 'both' : `all ${spots.length}`}</div>
      </div>`);
  }
  el.stats.innerHTML = tiles.join('');
}

// ---------------------------------------------------- hover: the exact journey

let probeId = 0;
let probeInFlight = false;
let probePending: { lat: number; lon: number } | null = null;
let cursor = { x: 0, y: 0 };
let rafQueued = false;
let hoverAt: L.LatLng | null = null;
/** Kept so switching the detailed place can redraw without probing again. */
let lastProbe: ProbeResult | null = null;

function requestProbe(lat: number, lon: number) {
  if (!ready) return;
  // Only one probe in flight; keep just the newest so fast moves don't queue up.
  if (probeInFlight) { probePending = { lat, lon }; return; }
  probeInFlight = true;
  probeId++;
  worker.postMessage({ type: 'probe', id: probeId, lat, lon });
}

map.on('mousemove', (e: L.LeafletMouseEvent) => {
  cursor = { x: e.containerPoint.x, y: e.containerPoint.y };
  hoverAt = e.latlng;
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (hoverAt) requestProbe(hoverAt.lat, hoverAt.lng);
  });
});

const hideHover = () => { el.hoverCard.hidden = true; hoverAt = null; lastProbe = null; };
map.on('mouseout dragstart zoomstart', hideHover);

/**
 * Round leg minutes so they still add up to the displayed total (largest
 * remainder), then make sure nothing shows as a bare "0m".
 */
function apportion(values: number[], total: number): number[] {
  const out = values.map((v) => Math.floor(v));
  let rem = total - out.reduce((a, b) => a + b, 0);

  const byFraction = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; rem > 0 && k < byFraction.length; k++, rem--) out[byFraction[k].i]++;
  for (let k = byFraction.length - 1; rem < 0 && k >= 0; k--) {
    if (out[byFraction[k].i] > 0) { out[byFraction[k].i]--; rem++; }
  }

  // Borrow a minute from the longest leg for anything that rounded away to zero.
  for (let i = 0; i < out.length; i++) {
    if (out[i] > 0) continue;
    const donor = out.indexOf(Math.max(...out));
    if (out[donor] > 1) { out[donor]--; out[i] = 1; }
  }
  return out;
}

function legRow(leg: Leg, minutes: number, compact: boolean): string {
  const colour = leg.kind === 'walk' ? '' : ensureContrast(leg.colour, isDark);
  const icon = legIcon(leg.kind, leg.kind === 'walk' ? 'walk' : leg.mode, colour);
  const pale = colour && isPale(colour) ? ' pale' : '';

  let title: string;
  let sub = '';
  let aside = '';
  if (leg.kind === 'walk') {
    if (leg.from && leg.from === leg.to) {
      // Two TfL records for one interchange, e.g. Bond Street tube <-> Elizabeth.
      title = 'Change';
      sub = `at ${leg.from}`;
    } else {
      // Legs run inbound, so a missing end is the hovered spot at the start and
      // the chosen place at the finish.
      title = 'Walk';
      sub = `${leg.from ?? 'here'} → ${leg.to ?? 'destination'}`;
    }
  } else if (leg.kind === 'wait') {
    title = `Wait for ${leg.lineName}`;
    if (!compact) sub = `at ${leg.at}`;
  } else {
    title = leg.lineName;
    sub = `${leg.from} → ${leg.to}`;
    // Stop count sits under the time so long station names get the full width.
    aside = `${leg.stops} stop${leg.stops === 1 ? '' : 's'}`;
  }

  return `
    <div class="leg">
      <span class="leg-icon${pale}">${icon}</span>
      <span class="leg-main">
        <span class="leg-title">${escapeHtml(title)}</span>
        ${sub ? `<span class="leg-sub">${escapeHtml(sub)}</span>` : ''}
      </span>
      <span class="leg-time">
        <span class="lt-v">${minutes}m</span>
        ${aside ? `<span class="lt-k">${aside}</span>` : ''}
      </span>
    </div>`;
}

/** The legs of one journey, or the note explaining why there are none. */
function legsBlock(journey: ProbeResult['journeys'][number]['journey']): string {
  if (!journey) {
    return `<div class="legs"><div class="leg-none">
      No station within a ${el.walkHome.value} min walk of here.
    </div></div>`;
  }
  const total = Math.round(journey.total);
  const shown = apportion(journey.legs.map((l) => l.minutes), total);
  // Long, many-change journeys would overflow a short viewport otherwise.
  const compact = journey.legs.length > 8 || spots.length > 1;
  return `<div class="legs${compact ? ' compact' : ''}">
    ${journey.legs.map((l, i) => legRow(l, shown[i], compact)).join('')}
  </div>`;
}

function drawHoverCard(res: ProbeResult) {
  if (!hoverAt || !spots.length) { hideHover(); return; }
  lastProbe = res;
  const byKey = new Map(res.journeys.map((j) => [j.key, j.journey]));
  const a = active();

  if (spots.length === 1) {
    const j = byKey.get(spots[0].key) ?? null;
    const total = j ? Math.round(j.total) : 0;
    el.hoverCard.innerHTML = `
      <div class="hover-total ${!j || !j.reachable ? 'over' : ''}">
        <span class="ht-v">${j ? `${total}<span class="ht-u">min</span>` : '—'}</span>
        <span class="ht-k">${
          !j ? 'no route' : j.reachable ? 'door to door' : `beyond ${el.time.value} min`
        }</span>
      </div>
      ${legsBlock(j)}`;
  } else {
    // With several places the totals are the headline; the itinerary shown
    // below belongs to whichever place is selected in the panel.
    const rows = spots.map((s, i) => {
      const j = byKey.get(s.key) ?? null;
      const over = !j || !j.reachable;
      return `
        <div class="hp-row${s.key === a?.key ? ' is-active' : ''}${over ? ' over' : ''}">
          <span class="pl-dot" style="background:${keyColor(PALETTES[s.palette])}"></span>
          <span class="hp-label">${escapeHtml(s.label)}</span>
          <kbd class="pl-key">${i + 1}</kbd>
          <span class="hp-time">${j ? `${Math.round(j.total)}<span class="ht-u">m</span>` : '—'}</span>
        </div>`;
    }).join('');

    el.hoverCard.innerHTML = `
      <div class="hover-places">${rows}</div>
      <div class="hover-head">
        <span>Route to ${escapeHtml(a?.label ?? '')}</span>
        <span class="hh-hint">press 1–${spots.length}</span>
      </div>
      ${legsBlock(a ? byKey.get(a.key) ?? null : null)}`;
  }

  el.hoverCard.hidden = false;

  // Keep the card beside the cursor, flipping before it runs off the map.
  const wrap = el.hoverCard.parentElement!.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = el.hoverCard;
  const pad = 16;
  const x = cursor.x + pad + w > wrap.width ? cursor.x - w - pad : cursor.x + pad;
  const y = Math.max(pad, Math.min(cursor.y - h / 2, wrap.height - h - pad));
  el.hoverCard.style.transform = `translate(${Math.max(pad, x)}px, ${y}px)`;
}

function toast(text: string, sticky = false) {
  el.toast.textContent = text;
  el.toast.hidden = !text;
  if (sticky) el.toast.style.borderColor = '#e34948';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

addSpot(51.5074, -0.1278, 'Charing Cross');
