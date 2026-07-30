/**
 * Official TfL line colours, and the icon each mode wears.
 *
 * These live in the front end rather than network.json because TfL's API doesn't
 * publish them — they're presentation, not network data.
 */

const LINE_COLOURS: Record<string, string> = {
  // Underground
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA',

  dlr: '#00A4A7',
  elizabeth: '#6950A1',
  tram: '#84B817',

  // London Overground, named lines (2024 onwards)
  liberty: '#61686B',
  lioness: '#FFA300',
  mildmay: '#006FE6',
  suffragette: '#18A95D',
  weaver: '#823A62',
  windrush: '#ED1B00',
};

/**
 * One shade for all National Rail operators. TfL publishes no colours and the
 * individual train-operator brands aren't worth guessing at, so the double-arrow
 * icon plus the operator's name carries the identity instead.
 */
const NATIONAL_RAIL = '#003366';

export function lineColour(lineId: string, mode: string): string {
  return LINE_COLOURS[lineId] ?? (mode === 'national-rail' ? NATIONAL_RAIL : '#6F7378');
}

/**
 * How a line should be named in a journey. TfL returns bare names ("Victoria",
 * "Mildmay"), which read as places until "line" is added; National Rail keeps
 * the operator name as-is.
 */
export function lineLabel(name: string, mode: string): string {
  if (mode === 'dlr') return 'DLR';
  if (mode === 'tram') return 'Tram';
  if (mode === 'national-rail') return name;
  return /\bline$/i.test(name) ? name : `${name} line`;
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** True where a light fill needs dark text/outline drawn over it. */
export function isPale(hex: string): boolean {
  return luminance(hex) > 0.65;
}

/**
 * Lift a line colour that would disappear against a dark surface — Northern is
 * pure black and National Rail navy is nearly as dark. Mixing toward white keeps
 * the hue recognisable while clearing the surface.
 */
export function ensureContrast(hex: string, onDark: boolean): string {
  const lum = luminance(hex);
  const target = 0.32;
  if (!onDark || lum >= target) return hex;

  const t = (target - lum) / (1 - lum);
  const lifted = channels(hex).map((c) => Math.round(c + t * (255 - c)));
  return `#${lifted.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const ROUNDEL = (colour: string) => `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="11" cy="11" r="7.2" fill="none" stroke="${colour}" stroke-width="3.4" />
    <rect x="1.4" y="9.2" width="19.2" height="3.6" fill="${colour}" />
  </svg>`;

const DOUBLE_ARROW = (colour: string) => `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <path fill="${colour}" d="M1.6 6.4h11.8l4 2.7H5.6zM20.4 15.6H8.6l-4-2.7h11.8z" />
  </svg>`;

const TRAM = (colour: string) => `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <rect x="5" y="3.4" width="12" height="12.4" rx="2.4" fill="${colour}" />
    <rect x="7.2" y="5.8" width="7.6" height="4.4" rx="1" fill="#fff" opacity=".85" />
    <path d="M4 18.6h14M8.4 15.8 7 19M13.6 15.8 15 19" stroke="${colour}"
          stroke-width="1.8" stroke-linecap="round" fill="none" />
  </svg>`;

const WALK = `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="12.4" cy="3.6" r="2.2" fill="currentColor" />
    <path d="M12.4 6.6 10 12.2 7.4 19.4M10 12.2l3.8 2.2 1.6 5M11.2 8.6l4.4 2.2"
          stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
          stroke-linejoin="round" fill="none" />
  </svg>`;

const CLOCK = `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="11" cy="11" r="7.4" fill="none" stroke="currentColor" stroke-width="1.9" />
    <path d="M11 6.4V11l3.2 2" stroke="currentColor" stroke-width="1.9"
          stroke-linecap="round" fill="none" />
  </svg>`;

/** Inline SVG for a leg. Rail icons take the line's colour; walk/wait inherit ink. */
export function legIcon(kind: 'walk' | 'wait' | 'ride', mode: string, colour: string): string {
  if (kind === 'walk') return WALK;
  if (kind === 'wait') return CLOCK;
  if (mode === 'national-rail') return DOUBLE_ARROW(colour);
  if (mode === 'tram') return TRAM(colour);
  return ROUNDEL(colour);
}
