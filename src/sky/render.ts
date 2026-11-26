/**
 * Sky: the airspace as a volume and its instrument panel, drawn as one 576 x 288 raster that is the
 * board's `sky.live` (`test/board/hud.cjs`), line by line. The glasses font is only used for the status
 * "Sky" and the three callsigns of the list (see `skyTexts`). See DESIGN.md, "The board is the reference".
 */
import { LENS, drawHeader } from "../core/board";
import { bearing, metresBetween } from "../core/geo";
import { GLYPHS } from "../core/font5x7";
import { Canvas, lv } from "../core/pixels";
import type { Osint } from "../core/protocol";
import { clipPx, fitPx, textWidth } from "../core/text";
import { ICON } from "./icon";

/** The lens raster. */
export const RW = LENS.width;
export const RH = LENS.height;
/** The list rows: one every 27 px, like text lines. */
export const ROW_H = 27;
export const LIST_ROWS = 3;
/** Where the list container sits (the board's `tx(callsign, 300, 134 + 27 i, 2)`), its width and its light. */
export const LIST_AT = { x: 300, y: 134, width: 276, level: 2 } as const;
/** The status text "Sky" (the board's header label at ox 300). */
export const STATUS_AT = { x: 332, y: 0, level: 3 } as const;

const CX = 144;
const CY = 196;
const TL = 0.42;
const MAX_KM = 60;
/** The opening: the radar acquires over this long (progress 0 to 1; 1 is the normal picture). */
export const OPEN_MS = 3000;
export const LADDER_END = 0.44;
const LADDER_TOP_FT = 40_000;

/** One aircraft as the screen needs it. The demo feeds the board's four straight in. */
export type SkyPlane = {
  id: string;
  callsign: string;
  /** Distance in km and bearing from you in degrees. */
  km: number;
  deg: number;
  track: number | null;
  /** Feet; null when unknown. */
  alt: number | null;
  kt: number | null;
  /** Feet a minute, when the feed has it. */
  vrate: number | null;
  emergency: boolean;
};

/** Everything the screen shows. */
export type SkyModel = {
  /** In range, nearest first. */
  planes: SkyPlane[];
  /** The aircraft you picked; null is the nearest. */
  selectedId: string | null;
  /** True when the feed is live and known: the count and the panel show. False draws the header only. */
  showCount: boolean;
  /** Replaces the list rows (nothing in range, no data, a notice). */
  message: string | null;
  noPosition: boolean;
  /** The header clock, "18:16". */
  clock: string;
  /** The opening's `RV`: 1 is the normal picture. */
  open: number;
  /** Whether the sweep turns (live traffic in range). */
  sweeping: boolean;
  /** Where the aircraft come from when it is not the owner's own receiver (for example "adsb.fi"). Absent: the board's footer. */
  source?: string | null;
};

export type Plane = Osint["aircraft"][number] & { km: number; deg: number };

/** Aircraft within 60 km of you, nearest first. */
export function planesInRange(osint: Osint | null): Plane[] {
  const me = osint?.me;
  if (!me) return [];
  return (osint?.aircraft ?? [])
    .map((a) => ({ ...a, km: metresBetween(me, a) / 1000, deg: bearing(me, a) }))
    .filter((p) => p.km <= MAX_KM)
    .sort((p, q) => p.km - q.km);
}

const callsignOf = (p: { callsign: string | null; id: string }): string => (p.callsign ?? p.id.toUpperCase()).slice(0, 8);

/** The most the panel and the list show: 99,999 ft, 999 kt (a longer value would not fit its column). */
const ALT_MAX = 99_999;
const KT_MAX = 999;

/** The one rule for altitude: whole feet, never below 0 (barometric altitude can be negative), at most `ALT_MAX`. Null stays unknown. */
export const cleanAltitude = (ft: number | null): number | null => (ft === null ? null : Math.min(ALT_MAX, Math.max(0, Math.round(ft))));
const cleanSpeed = (kt: number | null): number | null => (kt === null ? null : Math.min(KT_MAX, Math.max(0, Math.round(kt))));

/** The screen's precision: a metre and a hundredth of a degree, far below a pixel, so equal positions draw equal pixels. */
const precise = (value: number, per: number): number => Math.round(value * per) / per;

/** The feed's aircraft in range, as the screen needs them. */
export function skyPlanes(osint: Osint | null): SkyPlane[] {
  return planesInRange(osint).map((p) => ({
    id: p.id,
    callsign: callsignOf(p),
    km: precise(p.km, 1000),
    deg: precise(p.deg, 100),
    track: p.track,
    alt: cleanAltitude(p.altitude_ft),
    kt: cleanSpeed(p.speed_kt),
    vrate: p.vrate ?? null,
    emergency: p.emergency,
  }));
}

/** The selected aircraft: the one with this id, else the nearest. Null when none is in range. */
export function selectedPlane<T extends { id: string }>(planes: T[], id: string | null): T | null {
  return planes.find((p) => p.id === id) ?? planes[0] ?? null;
}

/** The three aircraft after the selected one, by distance, wrapping round to the nearest. */
export function othersAfter<T extends { id: string }>(planes: T[], selected: T | null): T[] {
  const at = selected ? planes.indexOf(selected) : -1;
  if (at < 0) return [];
  return [...planes.slice(at + 1), ...planes.slice(0, at)].slice(0, LIST_ROWS);
}

/** Swipe down (+1) selects the next aircraft out, swipe up (-1) the next one in; the ends stay put. Returns the new id. */
export function stepSelection<T extends { id: string }>(planes: T[], id: string | null, step: 1 | -1): string | null {
  const now = selectedPlane(planes, id);
  if (!now) return null;
  return planes[Math.min(planes.length - 1, Math.max(0, planes.indexOf(now) + step))]?.id ?? null;
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number): string => POINTS[Math.round(deg / 45) % 8] ?? "N";
const degrees = (deg: number): string => `${String(Math.round(deg) % 360).padStart(3, "0")}°`;
const thousands = (n: number): string => Math.round(n).toLocaleString("en-US");

/** "FL310" from 10,000 ft up, "4.5K" below; "-" when the altitude is unknown. */
export function altitudeLabel(ft: number | null): string {
  if (ft === null) return "-";
  return ft >= 10_000 ? `FL${Math.round(ft / 100)}` : `${(ft / 1000).toFixed(1)}K`;
}

/** The climb line under the bearing: the Loops daemon's own cut-off of 200 ft a minute. No rate, no line. */
export function climbLabel(vrate: number | null): string | null {
  if (vrate === null) return null;
  return vrate > 200 ? "CLIMBING" : vrate < -200 ? "DESCENDING" : "LEVEL";
}

/** The board's `ln`: a line, dotted when it has a pattern. */
function ln(c: Canvas, x0: number, y0: number, x1: number, y1: number, a: number, d: [number, number] | null = null): void {
  if (d) c.dashed(x0, y0, x1, y1, lv(a), d[0], d[1]);
  else c.line(x0, y0, x1, y1, lv(a));
}

/** The board's `plane`: an aircraft seen from above, turned to its track. */
function plane(c: Canvas, X: number, Y: number, deg: number, a: number): void {
  const r = ((deg - 90) * Math.PI) / 180;
  const tp = [X + Math.cos(r) * 6, Y + Math.sin(r) * 6] as const;
  const l = [X + Math.cos(r + 2.5) * 5, Y + Math.sin(r + 2.5) * 5] as const;
  const q = [X + Math.cos(r - 2.5) * 5, Y + Math.sin(r - 2.5) * 5] as const;
  ln(c, tp[0], tp[1], l[0], l[1], a);
  ln(c, tp[0], tp[1], q[0], q[1], a);
  ln(c, l[0], l[1], X, Y, a);
  ln(c, q[0], q[1], X, Y, a);
}

/** The board's `arr`: a bearing arrow, a shaft and a head, 5 px long each way. */
function arr(c: Canvas, cx: number, cy: number, deg: number, a: number): void {
  const r = ((deg - 90) * Math.PI) / 180;
  const dx = Math.cos(r);
  const dy = Math.sin(r);
  const hx = cx + dx * 5;
  const hy = cy + dy * 5;
  ln(c, cx - dx * 5, cy - dy * 5, hx, hy, a);
  ln(c, hx, hy, hx + Math.cos(r + 2.6) * 4, hy + Math.sin(r + 2.6) * 4, a);
  ln(c, hx, hy, hx + Math.cos(r - 2.6) * 4, hy + Math.sin(r - 2.6) * 4, a);
}

/** A point on the tilted disc (the board's `dp`). */
function dp(km: number, deg: number): [number, number] {
  const r = 134 * Math.sqrt(Math.min(km, MAX_KM) / MAX_KM);
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + Math.cos(a) * r, CY + Math.sin(a) * r * TL];
}

/** The board's `ell`: a ring of single pixels (every `step`th one) on the tilted disc. */
function ell(c: Canvas, r: number, a: number, step: number): void {
  const n = Math.round(r * 5);
  for (let k = 0; k < n; k++) {
    if (step && k % step) continue;
    const g = (k / n) * 6.283;
    c.p(CX + Math.cos(g) * r, CY + Math.sin(g) * r * TL, lv(a));
  }
}

/** How far the opening sweep has turned, 0 to 1 (the board's `rc`). */
const sweepFraction = (open: number): number => (open < 1 ? Math.max(0, Math.min(1, (open - LADDER_END) / 0.56)) : 1);

/**
 * Draws the whole lens like the board's `sky.live`. `c` is a `lensCanvas()`. `t` is the board's clock in
 * seconds: it turns the sweep (40 degrees a second) and marches the dashes while acquiring.
 */
export function renderSkyLens(c: Canvas, m: SkyModel, t: number): void {
  const RV = m.open;
  const ra = RV < 1 ? Math.min(1, RV / 0.3) : 1;
  const rb = RV < 1 ? Math.max(0, Math.min(1, (RV - 0.3) / 0.14)) : 1;
  const rc = sweepFraction(RV);
  const planes = m.planes;
  const sel = selectedPlane(planes, m.selectedId);
  /** The opening finds an aircraft when the sweep passes its bearing. */
  const found = (p: SkyPlane): boolean => RV >= 1 || !(rc * 360 < p.deg);
  const acq = RV < 1 && sel !== null && !found(sel);

  for (const km of [2, 10, 30]) {
    const r0 = 134 * Math.sqrt(km / 60);
    if (r0 <= 134 * ra) ell(c, r0, 0.45, 2);
  }
  if (ra >= 1) ell(c, 134, 0.9, 0);
  else {
    ell(c, 134 * ra, 1, 2);
    c.label(CX - 12, CY + 134 * ra * TL + 6, `${Math.round(60 * ra * ra)} KM`, lv(0.8));
  }
  if (ra >= 1) {
    for (let i = 0; i < 360; i += 30) {
      const a = ((i - 90) * Math.PI) / 180;
      ln(c, CX + Math.cos(a) * 125, CY + Math.sin(a) * 125 * TL, CX + Math.cos(a) * 134, CY + Math.sin(a) * 134 * TL, i % 90 ? 0.5 : 1);
    }
    c.textCenter(CX, CY - 134 * TL - 11, "N", lv(1));
    c.text(CX + 136, CY - 3, "E", lv(0.5));
    c.textCenter(CX, CY + 134 * TL + 5, "S", lv(0.5));
    c.text(CX - 141, CY - 3, "W", lv(0.5));
  }
  // The sweep: the board turns it 40 degrees a second; the opening makes one turn from north.
  if (m.sweeping && (RV >= 1 || rc > 0)) {
    const s = RV < 1 ? rc * 360 : (t * 40) % 360;
    for (let k = 9; k >= 0; k--) {
      const e = dp(60, s - k * 4);
      ln(c, CX, CY, e[0], e[1], k ? 0.4 : 1, k ? [1, k + 1] : null);
    }
  }
  if (rb > 0) ln(c, CX, CY, CX, CY - 134 * rb, 0.35, [1, 3]);
  for (let k = 1; k <= 4; k++) {
    if (rb < k / 4) continue;
    c.p(CX - 2, CY - k * 32, lv(0.5), 5, 1);
    c.p(0, CY - k * 32, lv(0.6), 5, 1);
    c.text(8, CY - k * 32 - 3, `${k * 10}K`, lv(0.5));
  }
  if (m.noPosition) c.textCenter(CX, CY + 40, "NO POSITION", lv(0.6));

  // Far ones first, so near ones stand in front; the selected one last.
  const order = planes
    .filter((p) => p !== sel)
    .map((p) => ({ p, ground: dp(p.km, p.deg) }))
    .sort((a, b) => a.ground[1] - b.ground[1])
    .map((e) => e.p);
  if (sel) order.push(sel);
  for (const pl of order) {
    let rs = 1;
    if (RV < 1) {
      if (!found(pl)) continue;
      rs = Math.min(1, (rc * 360 - pl.deg) / 45);
    }
    const g = dp(pl.km, pl.deg);
    // A stalk stops at the top of the ladder (40K), so a high aircraft and its label stay on the lens.
    const h = (Math.min(pl.alt ?? 0, LADDER_TOP_FT) / 1000) * 3.2 * rs;
    const mx = Math.round(g[0]);
    const my = Math.round(g[1] - h);
    const isSel = pl === sel;
    ln(c, g[0], g[1], mx, my, 0.5, [1, 2]);
    c.p(g[0] - 2, g[1], lv(0.6), 5, 1);
    c.p(g[0], g[1] - 1, lv(0.6), 1, 3);
    c.knockout(mx, my, 8);
    plane(c, mx, my, pl.track ?? 0, isSel ? 1 : 0.8);
    // Not on the board: an emergency has a ring.
    if (pl.emergency) c.circle(mx, my, 12, lv(1));
    if (isSel) {
      const v = lv(1);
      c.p(mx - 10, my - 10, v, 4, 1);
      c.p(mx - 10, my - 10, v, 1, 4);
      c.p(mx + 7, my - 10, v, 4, 1);
      c.p(mx + 10, my - 10, v, 1, 4);
      c.p(mx - 10, my + 10, v, 4, 1);
      c.p(mx - 10, my + 7, v, 1, 4);
      c.p(mx + 7, my + 10, v, 4, 1);
      c.p(mx + 10, my + 7, v, 1, 4);
    }
    if (!isSel && rs >= 1) {
      // The label sits on the side away from the centre. It is as wide as its longer line. A label that would
      // reach the divider (x 292) or the lens edge goes to the other side of the aircraft.
      const level = pl.emergency ? "EMERGENCY" : altitudeLabel(pl.alt);
      const w = Math.max(Canvas.textWidth(pl.callsign, 1), Canvas.textWidth(level, 1));
      const right = mx + 14;
      const left = mx - 14 - w;
      let lx = mx < CX ? left : right;
      if (lx + w > 290) lx = left;
      else if (lx < 2) lx = right;
      c.clearRect(lx - 2, my - 10, w + 4, 21);
      c.text(lx, my - 8, pl.callsign, lv(0.8));
      c.text(lx, my + 2, level, lv(pl.emergency ? 1 : 0.5));
    }
  }
  c.knockout(CX, CY, 5);
  c.disc(CX, CY, 2, lv(1));

  // The divider, then the right half.
  ln(c, 292, 0, 292, RH, 0.25, [1, 3]);
  c.clearRect(293, 0, 283, RH);
  drawHeader(c, ICON, m.clock, 300);
  if (m.showCount) {
    const nf = RV < 1 ? planes.filter(found).length : planes.length;
    c.text(342 + textWidth("Sky"), 11, `${nf} IN RANGE`, lv(0.5));
  }
  if (m.showCount && sel) {
    const climb = climbLabel(sel.vrate);
    if (acq) {
      c.text(300, 38, "ACQUIRING", lv(0.5));
      c.text(300, 49, "------".slice(0, 1 + (Math.floor(t * 6) % 6)), lv(0.5), 4, true);
    } else {
      const tag = sel.emergency ? "EMERGENCY" : sel === planes[0] && m.selectedId === null ? "NEAREST" : "SELECTED";
      c.text(300, 38, tag, lv(sel.emergency ? 1 : 0.5));
      c.text(300, 49, sel.callsign, lv(1), sel.callsign.length > 6 ? 3 : 4, true);
      arr(c, 458, 62, sel.deg, 1);
      c.text(472, 53, `${compass(sel.deg)} ${degrees(sel.deg)}`, lv(0.6));
      if (climb) c.text(472, 65, climb, lv(0.6));
    }
    const tiles: [string, string][] = [
      ["ALT FT", sel.alt === null ? "-" : thousands(sel.alt)],
      ["DIST KM", sel.km.toFixed(1)],
      ["SPD KT", sel.kt === null ? "-" : String(Math.round(sel.kt))],
    ];
    tiles.forEach(([label, value], i) => {
      c.text(300 + i * 92, 86, label, lv(0.5));
      c.text(300 + i * 92, 97, acq ? "-" : value, lv(1), 2);
    });
    ln(c, 386, 86, 386, 111, 0.3, [1, 2]);
    ln(c, 478, 86, 478, 111, 0.3, [1, 2]);
    c.p(300, 119, lv(0.3), 276, 1);
    c.text(300, 125, "OTHERS", lv(0.5));
    c.textRight(500, 125, "ALT", lv(0.5));
    c.textRight(RW, 125, "KM", lv(0.5));
    othersAfter(planes, sel).forEach((pl, i) => {
      if (!found(pl)) return;
      const y = LIST_AT.y + i * ROW_H;
      c.textRight(500, y + 7, pl.alt === null ? "-" : thousands(pl.alt), lv(0.75), 2);
      c.textRight(RW, y + 7, pl.km.toFixed(1), lv(0.75), 2);
    });
  }
  c.text(300, 276, footerText(m.source), lv(0.35));
}

/** The board's footer: the owner's own receiver. */
const BOARD_FOOTER = "ADS-B  ·  1090 MHZ  ·  PI RECEIVER";

/**
 * The footer under the panel. With a feed source it names the source ("ADS-B  ·  ADSB.FI") in upper case; a
 * character the pixel font does not have is dropped, and a name with nothing left gives the board's footer.
 */
export function footerText(source: string | null | undefined): string {
  const name = [...(source ?? "").toUpperCase()].filter((ch) => ch !== " " && GLYPHS[ch] !== undefined && ch !== "?").join("");
  return name ? `ADS-B  ·  ${name}` : BOARD_FOOTER;
}

/** The text lines of the list container: callsigns of the next three aircraft, "" for a row the opening has not found yet. */
export function listLines(m: SkyModel): string[] {
  const sel = selectedPlane(m.planes, m.selectedId);
  const rows = othersAfter(m.planes, sel);
  const found = (p: SkyPlane): boolean => {
    const rc = sweepFraction(m.open);
    return m.open >= 1 || !(rc * 360 < p.deg);
  };
  return rows.map((p) => (found(p) ? fitPx(`${p.emergency ? "■ " : ""}${p.callsign}`, 124) : ""));
}

/** The content of the list container: the callsigns, or a message wrapped by pixels to three lines. */
export function listText(m: SkyModel): string {
  if (m.message) return clipPx(m.message, LIST_AT.width, LIST_ROWS);
  return listLines(m).join("\n");
}

export type SkyText = { text: string; x: number; y: number; level: number };

/** Every glasses-font line the screen shows, each at its own place: what the board's `tx` calls give. */
export function skyTexts(m: SkyModel): SkyText[] {
  const lines = m.message ? listText(m).split("\n") : listLines(m);
  return [
    { text: "Sky", x: STATUS_AT.x, y: STATUS_AT.y, level: STATUS_AT.level },
    ...lines.flatMap((text, i) => (text ? [{ text, x: LIST_AT.x, y: LIST_AT.y + i * ROW_H, level: LIST_AT.level }] : [])),
  ];
}

/** The message that replaces the list rows, or null when there are rows. */
export function skyMessage(osint: Osint | null, notice: string | null, planeCount: number, looking = false): string | null {
  if (notice) return notice;
  if (!osint) return "Connecting…";
  if (!osint.connected) return ["The data feed is not reachable.", osint.error ?? ""].filter(Boolean).join("\n");
  if (!osint.me) return "No position yet.";
  if (planeCount === 0) return osint.missing?.includes("aircraft") ? (looking ? "Looking for aircraft…" : "No aircraft data.") : "Nothing in range.";
  return null;
}
