/**
 * Around: a full-screen live map. Four 288 x 144 tiles make the 576 x 288 canvas;
 * the bottom band is cleared in the raster (with a dithered fade) so the
 * glasses' own font can sit on it cleanly.
 */
import { bearing, distanceLabel, metresBetween, projector } from "../core/geo";
import { Canvas } from "../core/pixels";
import type { LocalMap, Osint } from "../core/protocol";
import { ellipsis } from "../core/text";

export const W = 576;
export const H = 288;
/** Metres per pixel: the screen covers about 2.9 km across. */
export const M_PER_PX = 5;
/** Where you sit on the canvas: centred, in the upper part (the text band is below). */
export const ME_X = W / 2;
export const ME_Y = 104;
/** Rows from here down are cleared for text; the fade starts a little above. */
export const BAND_Y = 200;
const FADE = 14;
export const LIST_CHARS = 62;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
type Pt = [number, number];

/** Road style by class: light and stipple together make the hierarchy. */
const ROAD_STYLE: Record<string, { light: number; pattern: [number, number] }> = {
  major: { light: 255, pattern: [1, 0] },
  rail: { light: 190, pattern: [3, 2] },
  street: { light: 150, pattern: [1, 1] },
  minor: { light: 120, pattern: [1, 2] },
  path: { light: 110, pattern: [1, 3] },
};

/**
 * Phase of the critical-incident ring, 0 to 1 (it grows and fades as the phase rises).
 * Around draws it at 1 frame a second, so the step per frame stays under half a cycle;
 * a faster rate would alias and run the ring backwards.
 */
export const pulsePhase = (t: number): number => (t * 0.25) % 1;

function mark(canvas: Canvas, x: number, y: number, severity: number, t: number): void {
  canvas.clear(x, y, severity >= 2 ? 7 : 4);
  if (severity >= 3) {
    canvas.disc(x, y, 3.5, 255);
    const p = pulsePhase(t);
    canvas.circle(x, y, 5 + p * 12, 255 * (1 - p));
  } else if (severity === 2) {
    canvas.disc(x, y, 2.5, 230);
    canvas.circle(x, y, 5, 110);
  } else if (severity === 1) canvas.circle(x, y, 2.5, 190);
  else canvas.plot(Math.round(x), Math.round(y), 160);
}

function arrow(canvas: Canvas, x: number, y: number, trackDeg: number, size: number, value: number): void {
  const a = ((trackDeg - 90) * Math.PI) / 180;
  const tip: Pt = [x + Math.cos(a) * size, y + Math.sin(a) * size];
  const l: Pt = [x + Math.cos(a + 2.5) * size * 0.8, y + Math.sin(a + 2.5) * size * 0.8];
  const r: Pt = [x + Math.cos(a - 2.5) * size * 0.8, y + Math.sin(a - 2.5) * size * 0.8];
  canvas.line(tip[0], tip[1], l[0], l[1], value);
  canvas.line(tip[0], tip[1], r[0], r[1], value);
  canvas.line(l[0], l[1], x, y, value * 0.7);
  canvas.line(r[0], r[1], x, y, value * 0.7);
}

export function renderAround(map: LocalMap | null, osint: Osint | null, t: number): Uint8Array {
  const canvas = new Canvas(W, H);
  const center = osint?.me ?? map?.center ?? null;
  if (!center) {
    canvas.text(ME_X - Canvas.textWidth("WAITING FOR A POSITION") / 2, ME_Y - 3, "WAITING FOR A POSITION", 140);
    return canvas.pixels;
  }
  const project = projector(center, M_PER_PX, ME_X, ME_Y);
  if (map) {
    // Water as diagonal hatching, parks as a dot grid: the classic map conventions, in light.
    canvas.fill(map.water.map((ring) => ring.map(project)), 110, "hatch");
    canvas.fill(map.green.map((ring) => ring.map(project)), 60, "dots");
    for (const cls of ["path", "minor", "street", "rail", "major"]) {
      const style = ROAD_STYLE[cls];
      if (!style) continue;
      for (const road of map.roads) if (road.class === cls) canvas.polyline(road.points.map(project), style.light, style.pattern);
    }
  }
  for (const v of osint?.vehicles ?? []) {
    const [x, y] = project([v.lat, v.lon]);
    canvas.clear(x, y, 2);
    canvas.disc(x, y, 1, 200);
  }
  for (const item of [...(osint?.items ?? [])].sort((a, b) => a.severity - b.severity)) {
    for (const line of item.lines) canvas.polyline(line.map(project), 150 + item.severity * 35, [3, 2]);
    if (item.lat !== null && item.lon !== null) {
      const [x, y] = project([item.lat, item.lon]);
      mark(canvas, x, y, item.severity, t);
    }
  }
  for (const a of osint?.aircraft ?? []) {
    const [x, y] = project([a.lat, a.lon]);
    if (x < -10 || x > W + 10 || y < -10 || y > H) continue;
    canvas.clear(x, y, 6);
    arrow(canvas, x, y, a.track ?? 0, 6, a.emergency ? 255 : 210);
    if (a.callsign) canvas.text(x + 8, y - 3, a.callsign, 170);
  }

  // You: knocked-out halo, dot, ring, ticks, and a heading beam.
  canvas.clear(ME_X, ME_Y, 12);
  canvas.disc(ME_X, ME_Y, 2.2, 255);
  canvas.circle(ME_X, ME_Y, 7, 200);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Pt[]) canvas.line(ME_X + dx * 9, ME_Y + dy * 9, ME_X + dx * 13, ME_Y + dy * 13, 255);
  const heading = osint?.me?.heading;
  if (heading !== null && heading !== undefined) {
    for (let k = -3; k <= 3; k++) {
      const h = ((heading + k * 6 - 90) * Math.PI) / 180;
      canvas.line(ME_X + Math.cos(h) * 9, ME_Y + Math.sin(h) * 9, ME_X + Math.cos(h) * 28, ME_Y + Math.sin(h) * 28, 120 * (1 - Math.abs(k) / 4));
    }
  }

  // Compass rose, top left, and a 500 m scale bar, top right under the clock.
  canvas.clear(20, 20, 16);
  canvas.circle(20, 20, 12, 120);
  canvas.text(18, 4, "N", 230);
  canvas.line(20, 12, 20, 28, 120);
  canvas.line(12, 20, 28, 20, 80);
  const bar = 500 / M_PER_PX;
  canvas.clear(W - 60, 44, 0);
  canvas.line(W - 8 - bar, 40, W - 8, 40, 150);
  canvas.line(W - 8 - bar, 37, W - 8 - bar, 42, 150);
  canvas.line(W - 8, 37, W - 8, 42, 150);
  canvas.text(W - 8 - bar, 45, "500M", 140);

  // Clear the clock corner and the text band, with a dithered fade into the band.
  for (let y = 0; y < 32; y++) for (let x = W - 60; x < W; x++) canvas.pixels[y * W + x] = 0;
  for (let y = BAND_Y - FADE; y < H; y++) {
    const keep = Math.max(0, (BAND_Y - y) / FADE) * 16;
    for (let x = 0; x < W; x++) if ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) >= keep) canvas.pixels[y * W + x] = 0;
  }
  canvas.line(0, BAND_Y + 1, W, BAND_Y + 1, 70);
  return canvas.pixels;
}

const SEVERITY_GLYPH = ["·", "○", "●", "■"];

/** The incidents that matter most near you, most severe first. */
export function incidentLines(osint: Osint | null): string[] {
  if (!osint) return ["Connecting to Loops…"];
  if (!osint.connected) return ["Loops is not reachable.", osint.error ?? ""].filter(Boolean);
  const me = osint.me;
  const ranked = osint.items
    .map((item) => ({ item, m: me && item.lat !== null && item.lon !== null ? metresBetween(me, { lat: item.lat, lon: item.lon }) : null }))
    .sort((a, b) => b.item.severity - a.item.severity || (a.m ?? 1e9) - (b.m ?? 1e9));
  if (ranked.length === 0) return [osint.missing?.includes("items") ? "No incident data from Loops." : "All quiet nearby."];
  return ranked.map(({ item, m }) => {
    const where = m !== null ? distanceLabel(m) : (item.area ?? "");
    const dir = me && item.lat !== null && item.lon !== null ? compass(bearing(me, { lat: item.lat, lon: item.lon })) : "";
    return ellipsis(`${SEVERITY_GLYPH[item.severity] ?? "·"} ${where} ${dir}  ${item.title}`.replace("  ", " ").replace(/ {3,}/g, "  "), LIST_CHARS);
  });
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => POINTS[Math.round(deg / 45) % 8] ?? "N";

export function aroundStatus(osint: Osint | null): string {
  if (!osint?.connected) return "AROUND";
  const where = osint.me?.area ?? (osint.me?.source === "home" ? "Home" : osint.me ? "Here" : "No fix");
  const alerts = osint.items.filter((i) => i.severity >= 2).length;
  const count = osint.missing?.includes("items") ? "? alerts" : `${alerts} alert${alerts === 1 ? "" : "s"}`;
  return `AROUND  ·  ${where}  ·  ${count}  ·  ${osint.aircraft.length} aircraft`;
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
    return `No update from Loops for ${Math.max(1, Math.round((nowS - osint.at) / 60))} min.`;
  }
  return null;
}

/** What to draw: the moving layers (incidents, aircraft, vehicles) only while the feed is live. */
export function drawable(osint: Osint | null, live: boolean): Osint | null {
  return live || !osint ? osint : { ...osint, items: [], aircraft: [], vehicles: [] };
}
