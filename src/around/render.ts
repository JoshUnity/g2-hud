/**
 * Around: the city in perspective, seen from where you stand. One 576 x 288 raster (four
 * 288 x 144 tiles) that equals the board's picture pixel for pixel (test/board-around.test.ts). The
 * drawing follows the board's `around.live` rule by rule: the same projection, the same alphas, the same
 * order. Text (the area name and two incident titles) is language and stays in the glasses' own text
 * containers; every bar, badge, number and the clock here is drawn.
 */
import { bearing, metresBetween, type LatLon } from "../core/geo";
import { LENS, STATUS_AT, drawHeader, lensCanvas } from "../core/board";
import { Canvas, lv } from "../core/pixels";
import type { LocalMap, Osint } from "../core/protocol";
import { clockText, textWidth } from "../core/text";
import { ICON } from "./icon";

export const W = LENS.width;
export const H = LENS.height;
/** Rows from here down belong to the two incident rows. */
export const BAND_Y = 226;
/** Rows above this belong to the header and the heading tape (the board clears 43 of them). */
const TOP_H = 43;
/** The row tops of the two incident rows, and the x of their text. */
export const ROW_Y = [232, 259] as const;
export const ROW_X = 22;
export const ROWS_PER_PAGE = 2;

/** Camera: 220 m behind you and 167 m up, looking north. Metres east and north of you to the lens. */
const HORIZON = 44;
const BEHIND = 220;
const EYE_X = 288;
/** Segments are cut where the projection stops making sense, and 1.6 km ahead; areas run further, to the horizon. */
const NEAR_Y = -150;
const FAR_Y = 1600;
const FAR_AREA_Y = 4000;

type Pt = [number, number];

/** A building outline from Loops: a closed outer ring and a height in metres. */
export type MapBuilding = { ring: [number, number][]; height: number };
/** The buildings of a map, none when Loops sent none. Read through a local type until every map type carries them. */
export const buildingsOf = (map: LocalMap | null): MapBuilding[] => (map as (LocalMap & { buildings?: MapBuilding[] }) | null)?.buildings ?? [];

/** Blocks beyond this are not drawn, and at most this many are (near ones first, then large ones). */
export const BLOCK_RANGE = 1000;
export const BLOCK_CAP = 40;
const BLOCK_NEAR = 300;
const BLOCK_CORNERS = 6;
/** A block counts as inside the lens when its centre is within this many pixels of the middle. */
const BLOCK_LENS = 340;

/** Rows a thing takes to rise to full height behind the load front. */
const RISE_ROWS = 26;
const FRONT_FROM = BAND_Y;
const FRONT_SPAN = BAND_Y - HORIZON;

/** Smoothstep of a linear progress 0..1: the load starts and ends gently. */
export const easeLoad = (r: number): number => {
  const c = Math.min(1, Math.max(0, r));
  return c * c * (3 - 2 * c);
};

/** The screen row of the load front for a progress `reveal` (eased, 0..1): from your feet (226) to the horizon (44). */
export const frontRow = (reveal: number): number => Math.round(FRONT_FROM - FRONT_SPAN * reveal);

/** The distance of the load front from you, as the label shows it: "0M", "110M", "1.6KM". */
export function frontLabel(row: number): string {
  const m = 33440 / Math.max(1, row - HORIZON) - BEHIND;
  return m < 1000 ? `${Math.max(0, Math.round(m / 10) * 10)}M` : `${(m / 1000).toFixed(1)}KM`;
}

/** The scan front: a bright dotted row with two dimmer ones behind it, and its labels. */
function drawFront(canvas: Canvas, row: number): void {
  for (let x = 0; x < W; x += 2) canvas.p(x, row, lv(1));
  for (let x = 1; x < W; x += 4) canvas.p(x, row + 3, lv(0.5));
  for (let x = 3; x < W; x += 8) canvas.p(x, row + 7, lv(0.3));
  if (row > 58) {
    const m = frontLabel(row);
    canvas.label(W - 34, row - 10, m, lv(1));
    canvas.label(4, row - 10, "MAPPING", lv(0.7));
  }
}

/** Metres east and north of you to the lens: x, y and the distance D along the view. */
export function lens(east: number, north: number, up = 0): [number, number, number] {
  const d = north + BEHIND;
  const s = 200 / d;
  return [EYE_X + east * s, HORIZON + 33440 / d - up * s, d];
}

/** Metres east and north of `origin`, to a micrometre: coordinates that came from round metres go back to them, so a pixel never flips on rounding noise. */
function metresFrom(origin: LatLon): (p: [number, number]) => Pt {
  const kx = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const micro = (v: number): number => Math.round(v * 1e6) / 1e6;
  return ([lat, lon]) => [micro((lon - origin.lon) * kx), micro((lat - origin.lat) * 110_540)];
}

/** The part of a segment inside lo <= north <= hi, or null. An uncut end is returned as it came. */
export function clipSegment(a: Pt, b: Pt, lo: number, hi: number): [Pt, Pt] | null {
  const dy = b[1] - a[1];
  if (dy === 0) return a[1] >= lo && a[1] <= hi ? [a, b] : null;
  let t0 = (lo - a[1]) / dy;
  let t1 = (hi - a[1]) / dy;
  if (t0 > t1) [t0, t1] = [t1, t0];
  t0 = Math.max(0, t0);
  t1 = Math.min(1, t1);
  if (t0 > t1) return null;
  const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + dy * t];
  return [t0 === 0 ? a : at(t0), t1 === 1 ? b : at(t1)];
}

/** A ring cut to lo <= north <= hi (Sutherland-Hodgman, one edge at a time). */
function clipRing(ring: Pt[], lo: number, hi: number): Pt[] {
  const cut = (pts: Pt[], inside: (p: Pt) => boolean, edge: number): Pt[] => {
    const out: Pt[] = [];
    pts.forEach((p, i) => {
      const q = pts[(i + pts.length - 1) % pts.length];
      if (!q) return;
      if (inside(p) !== inside(q)) {
        const t = (edge - q[1]) / (p[1] - q[1]);
        out.push([q[0] + (p[0] - q[0]) * t, edge]);
      }
      if (inside(p)) out.push(p);
    });
    return out;
  };
  return cut(cut(ring, (p) => p[1] >= lo, lo), (p) => p[1] <= hi, hi);
}

/** Calls `visit` for each lens pixel inside a ring of lens points (even-odd), between two rows. */
function scan(ring: Pt[], y0: number, y1: number, visit: (x: number, y: number) => void): void {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    const xs: number[] = [];
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      if (b && ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    });
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] ?? 0)); x <= Math.min(W - 1, Math.floor(xs[k + 1] ?? 0)); x++) visit(x, y);
    }
  }
}

const EDGE = 1e-6;

/** Whether a point is inside a ring, the edge included (even-odd), in metres. */
function inside(ring: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    // On the edge: inside.
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 0 && Math.abs(cross) / len < EDGE && x >= Math.min(a[0], b[0]) - EDGE && x <= Math.max(a[0], b[0]) + EDGE && y >= Math.min(a[1], b[1]) - EDGE && y <= Math.max(a[1], b[1]) + EDGE) return true;
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) hit = !hit;
  }
  return hit;
}

/**
 * How each road class is drawn, as the board draws its city. Minor roads are the dotted grid: dimmer the farther
 * they run (by the far end). A major road is two lines 4 m apart; a street is one solid line.
 */
const ROAD_STYLE: Record<string, { alpha: (farNorth: number) => number; pattern: [number, number]; twice?: boolean }> = {
  major: { alpha: () => 1, pattern: [1, 0], twice: true },
  street: { alpha: () => 0.6, pattern: [1, 0] },
  rail: { alpha: () => 0.75, pattern: [3, 2] },
  minor: { alpha: (n) => (n < 200 ? 0.5 : n < 700 ? 0.4 : 0.3), pattern: [1, 2] },
  path: { alpha: () => 0.45, pattern: [1, 3] },
};

/** A polyline on the ground; the pattern runs on across its segments. `alpha` may depend on the far end of a segment. */
function groundLine(canvas: Canvas, points: Pt[], alpha: (farNorth: number) => number, pattern: [number, number], far = FAR_Y, twice = false): void {
  let phase = 0;
  const draw = (a: Pt, b: Pt, v: number): void => {
    const [p, q] = [lens(a[0], a[1]), lens(b[0], b[1])];
    if (pattern[1] > 0) phase = canvas.dashed(p[0], p[1], q[0], q[1], v, pattern[0], pattern[1], phase);
    else canvas.line(p[0], p[1], q[0], q[1], v);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const cut = a && b ? clipSegment(a, b, NEAR_Y, far) : null;
    if (!cut) continue;
    const v = lv(alpha(Math.max(cut[0][1], cut[1][1])));
    draw(cut[0], cut[1], v);
    if (twice) draw([cut[0][0] + 4, cut[0][1]], [cut[1][0] + 4, cut[1][1]], v);
  }
}

/** The radius in metres of the growing ring of a critical incident at time `t`: 30 to 74 m, 22 m a second. */
export const pulseRadius = (t: number): number => 30 + ((t * 22) % 44);

/** Height of the stalk above an incident, in metres, by severity. */
const STALK = [0, 30, 46, 70];

function diamond(canvas: Canvas, x: number, y: number, filled: boolean): void {
  for (let i = 0; i < 6; i++) {
    if (filled) {
      canvas.p(x - i, y - 11 + i, lv(1), 2 * i + 1, 1);
      canvas.p(x - i, y - 1 - i, lv(1), 2 * i + 1, 1);
    } else {
      for (const dx of [-i, i]) {
        canvas.p(x + dx, y - 11 + i, lv(1));
        canvas.p(x + dx, y - 1 - i, lv(1));
      }
    }
  }
}

/** One incident: a stalk from its ground point up to a badge, and a growing ring when it is critical. */
function beacon(canvas: Canvas, east: number, north: number, severity: number, kind: string | null, t: number, front = 0): void {
  const [gx, gy] = lens(east, north);
  // While the map loads, a thing appears once the front has passed its foot, and rises over 26 rows.
  if (gy < front) return;
  const rise = front > 0 ? Math.min(1, (gy - front) / RISE_ROWS) : 1;
  if (severity <= 0) {
    canvas.p(gx - 1, gy - 1, lv(0.8), 3, 3);
    return;
  }
  if (severity >= 3) {
    const radius = pulseRadius(t);
    for (let i = 0; i < 72; i += 2) {
      const a = (i / 72) * 6.283;
      const [x, y] = lens(east + Math.sin(a) * radius, north + Math.cos(a) * radius);
      canvas.p(x, y, lv(0.75));
    }
  }
  const [tx, ty] = lens(east, north, (STALK[Math.min(3, severity)] ?? 0) * rise);
  canvas.line(gx, gy, tx, ty, lv(severity > 1 ? 1 : 0.6));
  canvas.p(gx - 2, gy, lv(0.8), 5, 1);
  canvas.knockout(tx, ty - 6, 8);
  const x = Math.round(tx);
  const y = Math.round(ty);
  if (severity >= 3) {
    diamond(canvas, x, y, true);
    canvas.clearRect(x, y - 9, 1, 4);
    canvas.clearRect(x, y - 4, 1, 1);
  } else if (severity === 2) {
    diamond(canvas, x, y, false);
    canvas.p(x - 1, y - 7, lv(1), 3, 3);
  } else canvas.circle(tx, ty - 4, 3, lv(0.8));
  if (kind && rise >= 1) canvas.label(tx + 11, ty - 9, kind, lv(severity >= 3 ? 1 : 0.7));
}

/** The small aircraft glyph: a thin arrowhead pointing along its track. */
function plane(canvas: Canvas, x: number, y: number, trackDeg: number, value: number): void {
  const r = ((trackDeg - 90) * Math.PI) / 180;
  const tip: Pt = [x + Math.cos(r) * 6, y + Math.sin(r) * 6];
  const left: Pt = [x + Math.cos(r + 2.5) * 5, y + Math.sin(r + 2.5) * 5];
  const right: Pt = [x + Math.cos(r - 2.5) * 5, y + Math.sin(r - 2.5) * 5];
  canvas.line(tip[0], tip[1], left[0], left[1], value);
  canvas.line(tip[0], tip[1], right[0], right[1], value);
  canvas.line(left[0], left[1], x, y, value);
  canvas.line(right[0], right[1], x, y, value);
}

/** A small arrow for a bearing, 0 = up. */
function arrow(canvas: Canvas, cx: number, cy: number, deg: number, value: number): void {
  const r = ((deg - 90) * Math.PI) / 180;
  const dx = Math.cos(r);
  const dy = Math.sin(r);
  const hx = cx + dx * 5;
  const hy = cy + dy * 5;
  canvas.line(cx - dx * 5, cy - dy * 5, hx, hy, value);
  canvas.line(hx, hy, hx + Math.cos(r + 2.6) * 4, hy + Math.sin(r + 2.6) * 4, value);
  canvas.line(hx, hy, hx + Math.cos(r - 2.6) * 4, hy + Math.sin(r - 2.6) * 4, value);
}

/** An aircraft's height above the ground on the lens, in metres: 110 at 1,800 ft, compressed, capped at 160. */
const aircraftUp = (ft: number | null): number => (ft === null ? 60 : Math.min(160, 110 * Math.sqrt(Math.max(0, ft) / 1800)));
const altitudeLabel = (ft: number | null): string => (ft === null ? "" : ft >= 10000 ? ` FL${Math.round(ft / 100)}` : ` ${(ft / 1000).toFixed(1)}K`);

// ---- The text of the two rows -------------------------------------------------

export type Row = { severity: number; title: string; dist: string | null; deg: number | null };

/** The distance as the raster shows it: "340M", "1.2KM". */
export function distanceText(m: number): string {
  // Round first, so 995 to 999 m reads "1.0KM" and not "1000M".
  const r = Math.round(m / 10) * 10;
  return r < 1000 ? `${r}M` : `${(m / 1000).toFixed(1)}KM`;
}

/** The incidents that need attention (severity 2 and 3) near you, most severe first, then nearest; the rest show on the map only. Empty while Loops is away. */
export function incidentRows(osint: Osint | null): Row[] {
  if (!osint?.connected) return [];
  const me = osint.me;
  return osint.items
    .filter((item) => item.severity >= 2)
    .map((item) => {
      const there = item.lat !== null && item.lon !== null ? { lat: item.lat, lon: item.lon } : null;
      const m = me && there ? metresBetween(me, there) : null;
      return { item, m, deg: me && there ? Math.round(bearing(me, there)) : null };
    })
    .sort((a, b) => b.item.severity - a.item.severity || (a.m ?? 1e9) - (b.m ?? 1e9))
    .map(({ item, m, deg }) => ({ severity: item.severity, title: item.title, dist: m === null ? null : distanceText(m), deg }));
}

/** What the rows say when there is no incident to list. */
export function messageLines(osint: Osint | null): string[] {
  if (!osint) return ["Connecting…"];
  if (!osint.connected) return ["The data feed is not reachable.", osint.error ?? ""].filter(Boolean);
  return [osint.missing?.includes("items") ? "No incident data for this area." : "All quiet nearby."];
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => POINTS[Math.round(deg / 45) % 8] ?? "N";

/** The status text: where you are. "Around" until Loops answers. */
export function aroundStatus(osint: Osint | null): string {
  if (!osint?.connected) return "Around";
  return osint.me?.area ?? (osint.me?.source === "home" ? "Home" : osint.me ? "Here" : "No fix");
}

/** The micro text after the status: "3 ALERTS  ·  4 AIRCRAFT" (an alert is an incident drawn as a beacon); empty while Loops is away. */
export function summaryText(osint: Osint | null): string {
  if (!osint?.connected) return "";
  const alerts = osint.items.filter((i) => i.severity >= 1).length;
  const count = osint.missing?.includes("items") ? "? ALERTS" : `${alerts} ALERT${alerts === 1 ? "" : "S"}`;
  return `${count}  ·  ${osint.aircraft.length} AIRCRAFT`;
}

export const pageCount = (rows: number): number => Math.max(1, Math.ceil(rows / ROWS_PER_PAGE));

/** A line of glasses text: its place (the line top) and light, as the board's `tx`. */
export type LensText = { text: string; x: number; y: number; level: number };

/** The glasses text of the live screen: the status at the header's place, then the titles of the rows on this page. */
export function aroundTexts(osint: Osint | null, rows: Row[], page = 0): LensText[] {
  const first = Math.min(page, pageCount(rows.length) - 1) * ROWS_PER_PAGE;
  return [
    { text: aroundStatus(osint), x: STATUS_AT.x, y: STATUS_AT.y, level: STATUS_AT.level },
    ...rows.slice(first, first + ROWS_PER_PAGE).map((row, i) => ({ text: row.title, x: ROW_X, y: ROW_Y[i] ?? 0, level: i === 0 ? 4 : 3 })),
  ];
}

// ---- The picture --------------------------------------------------------------

function drawRow(canvas: Canvas, y: number, row: Row, level: 3 | 4): void {
  const a = level === 4 ? 1 : 0.7;
  if (row.severity >= 3) {
    canvas.p(0, y + 8, lv(1), 11, 11);
    canvas.clearRect(5, y + 10, 1, 5);
    canvas.clearRect(5, y + 16, 1, 1);
  } else if (row.severity === 2) {
    canvas.circle(5, y + 13, 5, lv(0.8));
    canvas.p(4, y + 12, lv(0.8), 3, 3);
  } else if (row.severity === 1) canvas.circle(5, y + 13, 5, lv(0.8));
  else canvas.p(4, y + 12, lv(0.8), 3, 3);
  if (row.deg !== null) arrow(canvas, 566, y + 13, row.deg, lv(a));
  if (row.dist !== null) canvas.textRight(550, y + 7, row.dist, lv(a), 2);
}

/** What `renderAround` takes beyond the map and the feed. */
export type AroundOptions = {
  /** The header clock; by default the time now. */
  clock?: string;
};

/**
 * One frame of the lens. `osint` is what to draw (the moving layers are already left out when the
 * feed is not live, see `drawable`); `page` picks which two incidents get a row. When the feed
 * is not `live`, the counts in the header and the rows are left out too. `reveal` (0..1, already eased) is the
 * load: below 1 the ground above the scan front is not there yet; 1 is the normal picture.
 */
export function renderAround(map: LocalMap | null, osint: Osint | null, t: number, page = 0, live = true, reveal = 1, options: AroundOptions = {}): Uint8Array {
  const canvas = lensCanvas();
  const me = osint?.me ?? null;
  if (me) drawWorld(canvas, map, osint, me, t, reveal);
  else canvas.textCenter(W / 2, 140, "WAITING FOR A POSITION", lv(0.55));

  // The two bands: cleared, so the text containers and the header sit on black.
  canvas.clearRect(0, 0, W, TOP_H);
  drawHeader(canvas, ICON, options.clock ?? clockText(new Date()));
  if (me) {
    const summary = live ? summaryText(osint) : "";
    if (summary) canvas.text(46 + textWidth(aroundStatus(osint)), 11, summary, lv(0.5));
    for (const [name, x] of [["NW", 216], ["N", 288], ["NE", 360]] as const) canvas.textCenter(x, 33, name, lv(name === "N" ? 1 : 0.5));
    for (let x = 180; x <= 396; x += 12) if ([216, 288, 360].every((l) => Math.abs(x - l) > 8)) canvas.p(x, 35, lv(0.4), 1, 3);
    for (let x = 0; x < W; x += 3) canvas.p(x, HORIZON, lv(0.28));
  }
  canvas.clearRect(0, BAND_Y, W, H - BAND_Y);
  canvas.p(0, BAND_Y, lv(0.3), W, 1);

  const rows = live ? incidentRows(osint) : [];
  const pages = pageCount(rows.length);
  const first = Math.min(page, pages - 1) * ROWS_PER_PAGE;
  rows.slice(first, first + ROWS_PER_PAGE).forEach((row, i) => drawRow(canvas, ROW_Y[i] ?? 0, row, i === 0 ? 4 : 3));
  if (pages > 1) canvas.textRight(570, 229, `${Math.min(page, pages - 1) + 1}/${pages}`, lv(0.5));
  return canvas.pixels;
}

function drawWorld(canvas: Canvas, map: LocalMap | null, osint: Osint | null, me: LatLon & { heading: number | null }, t: number, reveal: number): void {
  const metres = metresFrom(me);
  const roads = (cls: string): void => {
    const style = ROAD_STYLE[cls];
    if (!style || !map) return;
    for (const road of map.roads) if (road.class === cls) groundLine(canvas, road.points.map(metres), style.alpha, style.pattern, FAR_Y, style.twice);
  };
  if (map) {
    // The dotted grid first; then water (cleared, then hatched) and parks (a dot lattice) over it; then the roads.
    roads("path");
    roads("minor");
    for (const ring of map.water) {
      const cut = clipRing(ring.map(metres), NEAR_Y, FAR_AREA_Y);
      if (cut.length < 3) continue;
      const flat = cut.map(([x, y]) => lens(x, y).slice(0, 2) as Pt);
      scan(flat, 31, BAND_Y - 1, (x, y) => (canvas.pixels[y * W + x] = 0));
      scan(flat, 31, BAND_Y - 1, (x, y) => ((x + y) % 5 === 0 ? canvas.p(x, y, lv(0.45)) : undefined));
    }
    for (const ring of map.green) {
      const pts = ring.map(metres);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      for (let x = Math.max(-1600, Math.ceil(Math.min(...xs) / 20 - EDGE) * 20); x <= Math.min(1600, Math.max(...xs) + EDGE); x += 20) {
        for (let y = Math.max(NEAR_Y, Math.ceil(Math.min(...ys) / 20 - EDGE) * 20); y <= Math.min(FAR_AREA_Y, Math.max(...ys) + EDGE); y += 20) {
          if (!inside(pts, x, y)) continue;
          const [px, py] = lens(x, y);
          canvas.p(px, py, lv(0.55));
        }
      }
    }
    roads("rail");
    roads("major");
    roads("street");
  }

  // Range rings, with their distances where they cross the middle of the lens.
  for (const radius of [250, 500]) {
    for (let i = 0; i < 240; i += 2) {
      const a = (i / 240) * 6.283;
      const north = Math.cos(a) * radius;
      if (north + BEHIND < 70) continue;
      const [x, y] = lens(Math.sin(a) * radius, north);
      canvas.p(x, y, lv(0.65));
    }
  }
  const [x250, y250] = lens(143, 205);
  canvas.label(x250 + 4, y250 - 3, "250", lv(0.6));
  const [x500, y500] = lens(250, 433);
  canvas.label(x500 + 4, y500 - 3, "500M", lv(0.6));

  // Where you face: a dim dotted wedge on the ground (the board has none; it shows only with a heading).
  if (me.heading !== null && me.heading !== undefined) {
    for (const turn of [-15, 0, 15]) {
      const a = ((me.heading + turn) * Math.PI) / 180;
      groundLine(canvas, [[0, 0], [Math.sin(a) * 260, Math.cos(a) * 260]], () => 0.4, [1, 2]);
    }
  }

  const target = (lat: number | null, lon: number | null): Pt | null => (lat === null || lon === null ? null : metres([lat, lon]));
  for (const v of osint?.vehicles ?? []) {
    const p = target(v.lat, v.lon);
    if (!p || p[1] < NEAR_Y || p[1] > FAR_Y) continue;
    const [x, y] = lens(p[0], p[1]);
    canvas.p(x - 1, y - 1, lv(0.8), 2, 2);
  }

  const items = [...(osint?.items ?? [])];
  const worst = new Set(
    [...items]
      .filter((i) => i.severity >= 1)
      .sort((a, b) => b.severity - a.severity || (metresBetween(me, { lat: a.lat ?? me.lat, lon: a.lon ?? me.lon }) - metresBetween(me, { lat: b.lat ?? me.lat, lon: b.lon ?? me.lon })))
      .slice(0, 2),
  );
  // Closures lie on the ground.
  for (const item of items) {
    for (const line of item.lines) groundLine(canvas, line.map(metres), () => Math.min(1, (150 + item.severity * 35) / 255), [3, 2]);
  }

  // The load: the ground above the front is not there yet. What stands up is drawn after the clear.
  let front = 0;
  if (reveal < 1) {
    front = frontRow(Math.max(0, reveal));
    canvas.clearRect(0, HORIZON, W, front - HORIZON);
    drawFront(canvas, front);
  }
  if (map) drawBlocks(canvas, buildingsOf(map).map((b) => ({ ring: b.ring.map(metres), height: b.height })), front);
  const placed = items.flatMap((item) => {
    const p = target(item.lat, item.lon);
    return p && p[1] >= NEAR_Y && p[1] <= FAR_Y && Math.abs(lens(p[0], p[1])[0] - EYE_X) < 280 ? [{ item, p }] : [];
  });
  // The worst last, so it stands on top.
  for (const { item, p } of placed.sort((a, b) => a.item.severity - b.item.severity)) {
    beacon(canvas, p[0], p[1], item.severity, worst.has(item) ? item.kind.toUpperCase().slice(0, 12) : null, t, front);
  }

  // Aircraft: the glyph on a dotted stalk above its ground point; the height is compressed and capped.
  for (const a of [...(osint?.aircraft ?? [])].sort((p, q) => metres([q.lat, q.lon])[1] - metres([p.lat, p.lon])[1])) {
    const [east, north] = metres([a.lat, a.lon]);
    if (north < NEAR_Y || north > FAR_Y) continue;
    const [gx, gy] = lens(east, north);
    const [px, topY] = lens(east, north, aircraftUp(a.altitude_ft));
    const py = Math.max(52, topY);
    if (px < 10 || px > W - 10 || gy < 52 || gy < front) continue;
    canvas.dashed(gx, gy, px, py, lv(0.4), 1, 2);
    canvas.p(gx - 2, gy, lv(0.5), 5, 1);
    canvas.knockout(px, py, 7);
    plane(canvas, px, py, a.track ?? 0, lv(1));
    if (a.callsign) {
      const label = `${a.callsign}${altitudeLabel(a.altitude_ft)}`;
      const width = Canvas.textWidth(label);
      canvas.label(px + 10 + width > W - 4 ? px - 10 - width : px + 10, py - 3, label, lv(0.8));
    }
  }

  // You: the small solid triangle with a knocked-out halo.
  const [mx, my] = lens(0, 0);
  if (my < front) return;
  canvas.knockout(mx, my, 12);
  for (let i = 0; i < 11; i++) canvas.p(mx - Math.floor(i * 0.6), my - 7 + i, lv(1), 1 + 2 * Math.floor(i * 0.6), 1);
  canvas.clearRect(mx - 1, my + 2, 3, 2);
}

/**
 * The wireframe blocks: for each building the footprint on the ground, the same ring at the roof, and a stalk at a
 * few corners. A block within 300 m (by its nearest north) is brighter. They are drawn in the order given.
 */
function drawBlocks(canvas: Canvas, buildings: { ring: Pt[]; height: number }[], front: number): void {
  const blocks = buildings.flatMap(({ ring, height }, index) => {
    const last = ring[ring.length - 1];
    const pts = ring.length > 1 && ring[0] && last && ring[0][0] === last[0] && ring[0][1] === last[1] ? ring.slice(0, -1) : ring;
    if (pts.length < 3) return [];
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const dist = Math.min(...pts.map((p) => Math.hypot(p[0], p[1])));
    if (cy < 10 || dist > BLOCK_RANGE || Math.abs(lens(cx, cy)[0] - EYE_X) > BLOCK_LENS) return [];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    return [{ pts, height, dist, area, index }];
  });
  // At most the cap: near blocks first, then large ones. They are drawn in the order they came.
  const kept = [...blocks].sort((a, b) => Number(b.dist <= BLOCK_NEAR) - Number(a.dist <= BLOCK_NEAR) || (a.dist <= BLOCK_NEAR ? a.dist - b.dist : b.area - a.area)).slice(0, BLOCK_CAP);
  for (const { pts, height } of kept.sort((a, b) => a.index - b.index)) {
    const ahead = pts.filter((p) => p[1] >= NEAR_Y);
    const foot = Math.max(...ahead.map((p) => lens(p[0], p[1])[1]));
    // In the load, a block appears when the front has passed its nearest ground point, and rises.
    if (front > 0 && foot < front) continue;
    const rise = front > 0 ? Math.min(1, (foot - front) / RISE_ROWS) : 1;
    const value = lv(Math.min(...pts.map((p) => p[1])) < BLOCK_NEAR ? 0.6 : 0.42);
    const roof = height * rise;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const cut = b ? clipSegment(a, b, NEAR_Y, FAR_Y) : null;
      if (!cut) return;
      for (const up of [0, roof]) {
        const [p, q] = [lens(cut[0][0], cut[0][1], up), lens(cut[1][0], cut[1][1], up)];
        canvas.line(p[0], p[1], q[0], q[1], value);
      }
    });
    const stride = Math.ceil(pts.length / BLOCK_CORNERS);
    pts.forEach(([x, y], i) => {
      if (i % stride !== 0 || y < NEAR_Y) return;
      const [gx, gy] = lens(x, y);
      const [, ty] = lens(x, y, roof);
      canvas.line(gx, gy, gx, ty, value);
    });
  }
}

/** A "connected" snapshot older than this is not shown as live (healthy polls come every 10 to about 36 s). */
export const STALE_S = 45;

/** The WebSocket to the HUD server: not yet open, open, or closed (it retries). */
export type Link = "connecting" | "open" | "closed";

/**
 * Why the live picture cannot be trusted, or null when it can. Shared by Around and Sky.
 * `nowS` is the phone clock in seconds; `osint.at` is the server's clock.
 */
export function feedNotice(osint: Osint | null, link: Link, serverError: string | null, nowS: number): string | null {
  if (serverError) return serverError;
  if (link === "closed") return "HUD server is not reachable.";
  if (osint?.connected && nowS - osint.at > STALE_S) {
    return `No new data for ${Math.max(1, Math.round((nowS - osint.at) / 60))} min.`;
  }
  return null;
}

/** What to draw: the moving layers (incidents, aircraft, vehicles) only while the feed is live. */
export function drawable(osint: Osint | null, live: boolean): Osint | null {
  return live || !osint ? osint : { ...osint, items: [], aircraft: [], vehicles: [] };
}
