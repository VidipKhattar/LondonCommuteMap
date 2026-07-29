import L from 'leaflet';
import './style.css';
import { suggest, prettyMode, type Place } from './geocode';
import type { ComputeResult, RouteOptions, StationHit, StationRef } from './types';

const MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'national-rail', 'tram'] as const;
const SERVICE_LABELS = ['Peak', 'Off-peak', 'Evening'];
const SERVICE_FACTORS = [1, 1.5, 2.5];

/** Sequential blue ramp, darkest (fastest) first. See style.css. */
const RAMP = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];

/** Spread `count` bands evenly across the ramp so adjacent bands stay distinct. */
function rampColor(i: number, count: number) {
  const step = count <= 1 ? 0 : Math.round((i * (RAMP.length - 1)) / (count - 1));
  return cssVar(RAMP[Math.min(step, RAMP.length - 1)]);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  search: $<HTMLInputElement>('search'),
  clear: $<HTMLButtonElement>('clear'),
  suggestions: $<HTMLUListElement>('suggestions'),
  originNote: $('origin-note'),
  time: $<HTMLInputElement>('time'),
  timeOut: $('time-out'),
  modes: $('modes'),
  service: $<HTMLInputElement>('service'),
  serviceOut: $('service-out'),
  walk: $<HTMLInputElement>('walk'),
  walkOut: $('walk-out'),
  access: $<HTMLInputElement>('access'),
  accessOut: $('access-out'),
  egress: $<HTMLInputElement>('egress'),
  egressOut: $('egress-out'),
  change: $<HTMLInputElement>('change'),
  changeOut: $('change-out'),
  showStations: $<HTMLInputElement>('show-stations'),
  legend: $('legend'),
  stats: $('stats'),
  stationList: $<HTMLOListElement>('station-list'),
  stationCount: $('station-count'),
  toast: $('toast'),
  built: $('built'),
  panel: $('panel'),
  panelToggle: $<HTMLButtonElement>('panel-toggle'),
};

// ----------------------------------------------------------------- state

let origin = { lat: 51.5074, lon: -0.1278, label: 'Charing Cross' }; // central London
let stationRefs: StationRef[] = [];
let ready = false;
let requestId = 0;
let inFlight = false;
let pending = false;

// ------------------------------------------------------------------- map

const map = L.map('map', {
  center: [origin.lat, origin.lon],
  zoom: 11,
  zoomControl: true,
  minZoom: 8,
  maxZoom: 18,
  preferCanvas: true,
});

const isDark = matchMedia('(prefers-color-scheme: dark)').matches;

// Bands from isobands nest rather than tile, so painting them individually
// translucent stacks their alpha and washes the ramp out. Instead each band is
// opaque and the whole pane is composited once — the topmost band wins per pixel.
map.createPane('iso').style.zIndex = '250';
map.getPane('iso')!.style.opacity = '0.62';
map.getPane('iso')!.style.pointerEvents = 'none';
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

const isoRenderer = L.canvas({ pane: 'iso' });

const isoLayer = L.geoJSON(undefined, {
  pane: 'iso',
  style: (f) => {
    const colour = rampColor(
      (f?.properties?.band as number) ?? 0,
      (f?.properties?.bandCount as number) ?? 1,
    );
    return {
      renderer: isoRenderer,
      color: colour, weight: 0,
      fillColor: colour, fillOpacity: 1,
      interactive: false,
    };
  },
}).addTo(map);

// Street labels ride above the isochrone so the map stays readable.
L.tileLayer(
  isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  { subdomains: 'abcd', maxZoom: 20, pane: 'labels' },
).addTo(map);

const stationLayer = L.layerGroup().addTo(map);

const originMarker = L.marker([origin.lat, origin.lon], {
  draggable: true,
  icon: L.divIcon({ className: '', html: '<div class="origin-pin"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
  zIndexOffset: 1000,
}).addTo(map);

originMarker.bindTooltip('Drag me, or click anywhere on the map', { className: 'stn', direction: 'top', offset: [0, -12] });

originMarker.on('dragend', () => {
  const { lat, lng } = originMarker.getLatLng();
  setOrigin(lat, lng, 'Pinned location');
});

map.on('click', (e: L.LeafletMouseEvent) => {
  setOrigin(e.latlng.lat, e.latlng.lng, 'Pinned location');
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
  }
};

worker.postMessage({ type: 'init', url: new URL('network.json', document.baseURI).href });
toast('Loading the London network…');

// ------------------------------------------------------------- controls

function options(): RouteOptions {
  return {
    maxTime: +el.time.value,
    walkSpeed: +el.walk.value,
    maxAccessWalk: +el.access.value,
    maxEgressWalk: +el.egress.value,
    transferPenalty: +el.change.value,
    serviceFactor: SERVICE_FACTORS[+el.service.value - 1],
    modes: MODES.filter((m) => ($(`mode-${m}`) as HTMLInputElement | null)?.checked),
  };
}

function schedule() {
  if (!ready) return;
  if (inFlight) { pending = true; return; }
  inFlight = true;
  requestId++;
  worker.postMessage({ type: 'compute', id: requestId, origin, opt: options() });
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
  el.accessOut.textContent = `${el.access.value} min`;
  el.egressOut.textContent = `${el.egress.value} min`;
  el.changeOut.textContent = `${el.change.value} min`;
};
syncLabels();

for (const input of [el.time, el.service, el.walk, el.access, el.egress, el.change]) {
  input.addEventListener('input', () => { syncLabels(); schedule(); });
}
el.modes.addEventListener('change', schedule);
el.showStations.addEventListener('change', () => drawStations(lastStations));

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
  }
});

el.search.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

el.clear.addEventListener('click', () => {
  el.search.value = '';
  el.clear.hidden = true;
  closeSuggestions();
  el.search.focus();
});

function choose(p: Place) {
  el.search.value = p.label;
  closeSuggestions();
  setOrigin(p.lat, p.lon, p.label, true);
}

function setOrigin(lat: number, lon: number, label: string, recentre = false) {
  origin = { lat, lon, label };
  originMarker.setLatLng([lat, lon]);
  el.originNote.textContent = `From ${label} · ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  // Picking a new place frames its reachable area; dragging the pin or moving
  // the slider leaves the view alone, which would otherwise be jarring.
  if (recentre) fitPending = true;
  schedule();
}

// -------------------------------------------------------------- render

let lastStations: StationHit[] = [];
let lastBreaks: number[] = [];
let fitPending = false;

function render(res: ComputeResult) {
  isoLayer.clearLayers();
  if (res.bands.features.length) isoLayer.addData(res.bands as never);

  if (fitPending) {
    fitPending = false;
    const bounds = isoLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13, animate: true });
    } else {
      map.setView([origin.lat, origin.lon], 12, { animate: true });
    }
  }

  lastBreaks = res.breaks;
  lastStations = res.stations;
  drawLegend(res.breaks);
  drawStations(res.stations);

  el.stats.innerHTML = `
    <div class="stat"><div class="v">${res.stats.areaKm2.toLocaleString()}</div><div class="k">km² reachable</div></div>
    <div class="stat"><div class="v">${res.stats.stationCount}</div><div class="k">stations</div></div>`;

  el.stationCount.textContent = res.stations.length ? `(${res.stations.length})` : '';
  el.stationList.innerHTML = res.stations.slice(0, 300).map((s, i) => `
    <li data-i="${i}">
      <span>${escapeHtml(s.name)}</span>
      <span class="sm">${prettyMode(s.mode)}</span>
      <span class="t">${Math.round(s.t)}m</span>
    </li>`).join('') || '<li class="sm" style="cursor:default">No stations within this time.</li>';

  toast(`Computed in ${res.stats.ms} ms`);
  setTimeout(() => toast(''), 1400);
}

el.stationList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li?.dataset.i) return;
  const s = lastStations[+li.dataset.i];
  if (s) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 14), { animate: true });
});

function bandFor(t: number, breaks: number[]) {
  for (let i = 1; i < breaks.length; i++) if (t <= breaks[i]) return i - 1;
  return breaks.length - 2;
}

function drawStations(stations: StationHit[]) {
  stationLayer.clearLayers();
  if (!el.showStations.checked) return;

  const bandCount = Math.max(1, lastBreaks.length - 1);
  for (const s of stations) {
    L.circleMarker([s.lat, s.lon], {
      radius: 4,
      color: cssVar('--dot-stroke'),
      weight: 1.2,
      fillColor: rampColor(bandFor(s.t, lastBreaks), bandCount),
      fillOpacity: 1,
    })
      .bindTooltip(`${escapeHtml(s.name)} · <b>${Math.round(s.t)} min</b>`, {
        className: 'stn', direction: 'top', offset: [0, -6],
      })
      .addTo(stationLayer);
  }
}

function drawLegend(breaks: number[]) {
  const n = breaks.length - 1;
  const swatches = Array.from({ length: n }, (_, i) =>
    `<span style="background:${rampColor(i, n)}"></span>`).join('');
  const labels = breaks.map((b) => `<span>${b}</span>`).join('');
  el.legend.innerHTML =
    `<div class="legend-bar">${swatches}</div><div class="legend-labels">${labels}</div>` +
    `<div class="legend-labels"><span>minutes door to door</span></div>`;
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

setOrigin(origin.lat, origin.lon, origin.label);
