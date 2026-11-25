/**
 * Sky: a full-height radar (two 288 x 144 tiles stacked) for the aircraft your
 * Pi's ADS-B receiver hears. Square-root range scale, so near traffic gets room.
 */
import { bearing, metresBetween } from "../core/geo";
import { Canvas } from "../core/pixels";
import type { Osint } from "../core/protocol";

export const RW = 288;
export const RH = 288;
const CX = 144;
const CY = 146;
const R = 136;
export const RINGS_KM = [2, 10, 30, 60];
const MAX_KM = 60;
type Pt = [number, number];

function at(km: number, deg: number): Pt {
  const r = R * Math.sqrt(Math.min(km, MAX_KM) / MAX_KM);
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
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

export type Plane = Osint["aircraft"][number] & { km: number; deg: number };

export function planesInRange(osint: Osint | null): Plane[] {
  const me = osint?.me;
  if (!me) return [];
  return (osint?.aircraft ?? [])
    .map((a) => ({ ...a, km: metresBetween(me, a) / 1000, deg: bearing(me, a) }))
    .filter((p) => p.km <= MAX_KM)
    .sort((p, q) => p.km - q.km);
}

/**
 * Frames a second for the radar: 1 while live traffic is in range (the sweep turns),
 * else 0 (a still radar, sent only when it changes). The server keeps `me` but no
 * aircraft when Loops fails, and `connected` is checked too.
 */
export function skyFps(osint: Osint | null): number {
  return osint?.connected && planesInRange(osint).length > 0 ? 1 : 0;
}

export function renderSky(osint: Osint | null, t: number): Uint8Array {
  const canvas = new Canvas(RW, RH);
  // Rings, labelled in the pixel font; bearing ticks every 30°.
  for (const km of RINGS_KM) {
    const r = R * Math.sqrt(km / MAX_KM);
    canvas.circle(CX, CY, r, km === MAX_KM ? 110 : 50);
    const [lx, ly] = at(km, 135);
    canvas.text(lx + 2, ly - 2, `${km}`, 90);
  }
  for (let deg = 0; deg < 360; deg += 30) {
    const [x0, y0] = at(MAX_KM * 0.92, deg);
    const [x1, y1] = at(MAX_KM, deg);
    canvas.line(x0, y0, x1, y1, deg % 90 === 0 ? 200 : 90);
  }
  canvas.clear(CX, CY - R - 1, 6);
  canvas.text(CX - 2, CY - R - 4, "N", 255);

  // 30° a frame at 1 fps, about the width of the fan; no sweep without live traffic,
  // so an idle radar does not depend on t and costs no sends.
  if (skyFps(osint) > 0) {
    const sweep = (t * 30) % 360;
    for (let k = 0; k < 10; k++) {
      const [x, y] = at(MAX_KM, sweep - k * 3.5);
      canvas.line(CX, CY, x, y, k === 0 ? 210 : 70 * (1 - k / 10) ** 2);
    }
  }

  const me = osint?.me;
  if (!me) {
    canvas.text(CX - Canvas.textWidth("NO POSITION") / 2, CY + 20, "NO POSITION", 160);
  }
  const planes = planesInRange(osint);
  planes.forEach((p, i) => {
    if (!me) return;
    const trail = p.trail.slice(-15).map(([lat, lon]) => at(metresBetween(me, { lat, lon }) / 1000, bearing(me, { lat, lon })));
    for (let j = 1; j < trail.length; j++) {
      const a = trail[j - 1];
      const b = trail[j];
      if (a && b) canvas.line(a[0], a[1], b[0], b[1], 30 + (j / trail.length) * 80);
    }
    const [x, y] = at(p.km, p.deg);
    canvas.clear(x, y, 6);
    arrow(canvas, x, y, p.track ?? 0, 6, p.emergency ? 255 : 235);
    if (i < 5) {
      const label = (p.callsign ?? p.id).slice(0, 8);
      const flip = x > CX + 40;
      const lx = flip ? x - 9 - Canvas.textWidth(label) : x + 9;
      canvas.text(lx, y - 3, label, 200);
    }
  });
  // You, in the centre.
  canvas.disc(CX, CY, 2, 255);
  canvas.circle(CX, CY, 5, 150);
  return canvas.pixels;
}

/** Text beside the radar: each aircraft on two lines. */
export function skyLines(osint: Osint | null): string[] {
  if (!osint) return ["Connecting to Loops…"];
  if (!osint.connected) return ["Loops is not reachable.", osint.error ?? ""].filter(Boolean);
  const planes = planesInRange(osint);
  if (planes.length === 0) return [osint.missing?.includes("aircraft") ? "No aircraft data from Loops." : "Nothing in range."];
  return planes.flatMap((p) => {
    // The server drops aircraft on the ground, so a null altitude is unknown, not "on ground".
    const parts = [
      p.altitude_ft === null ? null : `${p.altitude_ft.toLocaleString("en-GB")} ft`,
      `${p.km.toFixed(1)} km`,
      p.speed_kt ? `${Math.round(p.speed_kt)} kt` : null,
    ].filter(Boolean);
    return [`${p.emergency ? "■ " : ""}${p.callsign ?? p.id.toUpperCase()}`, `   ${parts.join(" · ")}`];
  });
}
