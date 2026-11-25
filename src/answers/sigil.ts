/**
 * The Sigil: a wireframe icosahedron drawn in software, the HUD's 3D presence.
 * It renders one grey frame (0-255 per pixel, the glasses quantise to 16 levels)
 * for a mode, a time in seconds and a voice level from 0 to 1.
 */
export type SigilMode = "connecting" | "listening" | "thinking" | "answer" | "paused" | "error" | "saved";

import { Canvas } from "../core/pixels";

type Vec3 = [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;
const RAW: Vec3[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const LENGTH = Math.hypot(1, PHI);
export const VERTICES: Vec3[] = RAW.map(([x, y, z]) => [x / LENGTH, y / LENGTH, z / LENGTH]);
/** The 30 edges: vertex pairs at the shortest distance (2 before normalising). */
export const EDGES: [number, number][] = [];
for (let a = 0; a < RAW.length; a++) {
  for (let b = a + 1; b < RAW.length; b++) {
    const [ax, ay, az] = RAW[a] as Vec3;
    const [bx, by, bz] = RAW[b] as Vec3;
    if (Math.abs(Math.hypot(ax - bx, ay - by, az - bz) - 2) < 1e-6) EDGES.push([a, b]);
  }
}

function rotate([x, y, z]: Vec3, yaw: number, pitch: number, roll = 0): Vec3 {
  let c = Math.cos(yaw);
  let s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(roll);
  s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * One frame. `t` is seconds since start, `since` seconds since the mode began,
 * `level` the smoothed voice level.
 */
export function renderSigil(mode: SigilMode, t: number, since: number, level: number, size = 64): Uint8Array {
  const canvas = new Canvas(size, size);
  const c = size / 2;
  const radius = size * 0.34;

  if (mode === "paused") {
    // Folded flat: a quiet ring, nothing moves.
    canvas.circle(c, c, radius * 0.9, 90);
    canvas.line(c - radius * 0.35, c, c + radius * 0.35, c, 90);
    return canvas.pixels;
  }

  const speed = { connecting: 0.3, listening: 0.55, thinking: 2.4, answer: 0.4, error: 0.15, saved: 1.2 }[mode];
  const yaw = t * speed;
  const pitch = mode === "thinking" ? t * 1.3 : 0.42 + 0.12 * Math.sin(t * 0.5);
  const breathe = mode === "listening" ? 1 + 0.04 * Math.sin(t * 1.6) + level * 0.22 : 1;
  // Answer: a short "landing" squash when the answer arrives.
  const land = mode === "answer" && since < 0.8 ? 1 + 0.25 * Math.sin((since / 0.8) * Math.PI) * (1 - since / 0.8) : 1;
  const peak = mode === "connecting" || mode === "error" ? 150 : 255;

  const projected = VERTICES.map((v, i) => {
    const ripple = mode === "listening" ? 1 + level * 0.12 * Math.sin(t * 9 + i * 1.7) : 1;
    const [x, y, z] = rotate(v, yaw, pitch);
    const k = breathe * land * ripple;
    const perspective = 3 / (3.4 - z * k);
    return { x: c + x * k * radius * perspective, y: c - y * k * radius * perspective, z };
  });

  EDGES.forEach(([a, b], i) => {
    if (mode === "error" && i % 3 === 0) return; // broken edges
    const p = projected[a];
    const q = projected[b];
    if (!p || !q) return;
    // Depth shading: front edges burn bright, back edges fade.
    const depth = clamp01(((p.z + q.z) / 2 + 1) / 2);
    canvas.line(p.x, p.y, q.x, q.y, peak * (0.22 + 0.78 * depth * depth));
  });

  if (mode === "thinking") {
    // Orbit ring, tilted, sweeping around the body.
    const segments = 36;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const ring = (a: number): Vec3 => rotate([Math.cos(a) * 1.4, 0, Math.sin(a) * 1.4], t * 3.1, 1.1, 0.35);
      const [x0, y0, z0] = ring(a0);
      const [x1, y1] = ring(a1);
      const head = (((a0 - t * 4) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const trail = 1 - head / (Math.PI * 2);
      canvas.line(c + x0 * radius, c - y0 * radius, c + x1 * radius, c - y1 * radius, 255 * clamp01(0.15 + trail * 0.85) * (z0 > 0 ? 1 : 0.5));
    }
  }

  if (mode === "answer") {
    canvas.disc(c, c, 3 + (since < 0.8 ? 2 * (1 - since / 0.8) : 0), 255);
    if (since < 1.2) canvas.circle(c, c, radius * (0.6 + since), 255 * (1 - since / 1.2)); // shockwave
  }

  if (mode === "saved") {
    // Two rings expanding outward, like a pulse being sent away.
    for (const offset of [0, 0.35]) {
      const p = clamp01((since - offset) / 1.1);
      if (p > 0 && p < 1) canvas.circle(c, c, radius * (0.5 + p * 0.9), 255 * (1 - p));
    }
  }

  return canvas.pixels;
}

/** Frames per second each mode needs. Lower is better for the battery and the Bluetooth link. */
export function sigilFps(mode: SigilMode, since: number, level: number): number {
  if (mode === "paused") return 0;
  if (mode === "thinking" || mode === "saved") return 8;
  if (mode === "answer") return since < 1.4 ? 8 : 2;
  if (mode === "listening") return level > 0.08 ? 8 : 3;
  return 2;
}
