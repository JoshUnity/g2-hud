import { drawHeader, lensCanvas } from "../core/board";
import type { IconGrid } from "../core/icon";
import type { Canvas } from "../core/pixels";
import { lv } from "../core/pixels";
import { project, rotate, type Vec3 } from "../core/three";
import { ICON } from "./icon";
import type { HackMode, HackScreen } from "./view";

/**
 * The whole HackOS lens as one 576 x 288 raster, ported line by line from the board's engine (`test/board/hud.cjs`:
 * `core`, `boot`, and the `hackos` screens `waking` and `answer`). Only the glasses-font text is not in it.
 */

// ---- The icosahedron (the board's IV and IE) --------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2;
const LENGTH = Math.hypot(1, PHI);
const RAW: Vec3[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
/** Twelve vertices on the unit sphere. */
export const VERTICES: Vec3[] = RAW.map(([x, y, z]) => [x / LENGTH, y / LENGTH, z / LENGTH]);
/** The thirty edges: vertex pairs at the shortest distance. */
export const EDGES: [number, number][] = [];
for (let a = 0; a < RAW.length; a++) {
  for (let b = a + 1; b < RAW.length; b++) {
    const [ax, ay, az] = RAW[a] as Vec3;
    const [bx, by, bz] = RAW[b] as Vec3;
    if (Math.abs(Math.hypot(ax - bx, ay - by, az - bz) - 2) < 1e-6) EDGES.push([a, b]);
  }
}

/** Alphas of an edge (near, far), a vertex, and an edge not yet lit. The board has `quiet` and bright. */
type Look = { near: number; far: number; vertex: number; unlit: number };
const BRIGHT: Look = { near: 1, far: 0.5, vertex: 1, unlit: 0.4 };
const QUIET: Look = { near: 0.7, far: 0.35, vertex: 0.7, unlit: 0.4 };
const MID: Look = { near: 0.85, far: 0.42, vertex: 0.85, unlit: 0.4 };
const DIM: Look = { near: 0.45, far: 0.25, vertex: 0.45, unlit: 0.25 };

/** Which of three steps a voice level from 0 to 1 is on. */
export const voiceStep = (level: number): number => (level < 0.15 ? 0 : level < 0.45 ? 1 : 2);

type CoreOptions = {
  look: Look;
  /** The orbit ring and its satellite (the board's non-quiet core). */
  ring?: boolean;
  /** Turns at the board's quiet speed (.35) instead of .6. */
  slow?: boolean;
  /** How many edges are lit; the rest are dotted. All by default. */
  lit?: number;
  /** Every third edge is missing. */
  broken?: boolean;
};

/** The board's `core(cx, cy, R, pg, quiet)`. */
export function drawCore(c: Canvas, cx: number, cy: number, R: number, t: number, o: CoreOptions): void {
  const yaw = t * (o.slow ? 0.35 : 0.6);
  const pit = 0.42 + 0.12 * Math.sin(t * 0.5);
  const P = VERTICES.map((v) => project(rotate(v, yaw, pit), cx, cy, R));
  const n = o.lit ?? EDGES.length;
  EDGES.forEach(([ia, ib], i) => {
    if (o.broken && i % 3 === 2) return;
    const a = P[ia];
    const b = P[ib];
    if (!a || !b) return;
    const z = (a.z + b.z) / 2;
    if (i < n) c.line(a.x, a.y, b.x, b.y, lv(z < 0 ? o.look.near : o.look.far));
    else c.dashed(a.x, a.y, b.x, b.y, lv(o.look.unlit), 1, 2);
  });
  for (const q of P) if (q.z < 0) c.p(q.x - 1, q.y - 1, lv(o.look.vertex), 3, 3);
  if (o.ring) {
    for (let k = 0; k < 90; k++) {
      const g = (k / 90) * 6.283;
      const v = rotate([Math.cos(g) * 1.5, 0, Math.sin(g) * 1.5], t * 0.9, 1.15);
      const q = project(v, cx, cy, R);
      c.p(q.x, q.y, lv(v[2] < 0 ? 0.75 : 0.4));
    }
    const sv = rotate([Math.cos(t * 2) * 1.5, 0, Math.sin(t * 2) * 1.5], t * 0.9, 1.15);
    const s = project(sv, cx, cy, R);
    c.p(s.x - 1, s.y - 1, lv(1), 3, 3);
  }
}

/** The board's `boot(cx, cy, R)` at opening progress `rv` (0 to 1): points, then links, then online, with a label. */
export function drawBoot(c: Canvas, cx: number, cy: number, R: number, t: number, rv: number): void {
  const P = VERTICES.map((v) => project(rotate(v, t * 0.6, 0.42), cx, cy, R));
  const nv = Math.round(12 * Math.min(1, rv / 0.3));
  const ne = Math.round(30 * Math.max(0, Math.min(1, (rv - 0.3) / 0.55)));
  EDGES.forEach(([ia, ib], i) => {
    if (i >= ne) return;
    const a = P[ia];
    const b = P[ib];
    if (a && b) c.line(a.x, a.y, b.x, b.y, lv((a.z + b.z) / 2 < 0 ? 1 : 0.5));
  });
  for (let i = 0; i < nv; i++) {
    const q = P[i];
    if (q) c.p(q.x - 1, q.y - 1, lv(1), 3, 3);
  }
  c.textCenter(cx, cy + R + 14, rv < 0.3 ? "CORE" : rv < 0.85 ? "LINKING" : "CORE ONLINE", lv(0.6));
}

/** The opening (the core boots) runs this long. */
export const BOOT_MS = 2000;

/** `load=<0..1>` freezes the opening at that progress, `load=off` skips it, no parameter plays it. */
export function bootParam(search: string): { off: boolean; frozen: number | null } {
  const value = new URLSearchParams(search).get("load");
  if (value === "off") return { off: true, frozen: null };
  const n = value === null || value.trim() === "" ? NaN : Number(value);
  return { off: false, frozen: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null };
}

// ---- The header icon ----------------------------------------------------------------

/** The dashed signal bar sits in rows 5 and 6, columns 2 to 9 of the icon. */
const BAR_ROWS = [5, 6] as const;
const BAR_FROM = 2;
const BAR_TO = 9;

function withBar(grid: IconGrid, cell: (col: number) => "#" | "+" | "."): IconGrid {
  const rows = grid.map((row) => [...row]);
  for (const r of BAR_ROWS) for (let col = BAR_FROM; col <= BAR_TO; col++) (rows[r] as string[])[col] = cell(col);
  return rows.map((row) => row.join(""));
}

/** The header icon for a mode at time `t` (seconds), with a voice level from 0 to 1. Waking is the board's `frame()`. */
export function iconFrame(mode: HackMode, t: number, level: number): IconGrid {
  switch (mode) {
    case "off":
      return withBar(ICON.map((row) => row.replace(/#/g, "+")), () => ".");
    case "recording": {
      // The two dashes grow outward with the voice.
      const reach = voiceStep(level) + 1;
      return withBar(ICON, (col) => (col === 5 || col === 6 ? "." : Math.min(Math.abs(col - 4), Math.abs(col - 7)) < reach ? "#" : "+"));
    }
    case "working": {
      // The dashes march along the bar.
      const k = Math.floor(t * 4) % 4;
      return withBar(ICON, (col) => {
        const phase = (((col - k) % 4) + 4) % 4;
        return phase === 3 || phase === 0 ? "#" : ".";
      });
    }
    case "waking": {
      // The board: the bar fills from left to right, two cells a second, nine steps.
      const f = Math.floor(t * 2) % 9;
      return withBar(ICON, (col) => (col - BAR_FROM < f ? "#" : "+"));
    }
    default:
      return ICON;
  }
}

// ---- The lens ---------------------------------------------------------------------

export type LensOptions = {
  /** Seconds: turns the core, steps the icon. */
  t: number;
  /** The clock text, "18:16". */
  clock: string;
  /** The opening's progress, 0 to 1; 1 (the default) means no opening. */
  reveal?: number;
  /** Voice level, 0 to 1 (recording). */
  level?: number;
};

/**
 * The core in the answer layout. The board has one: the resting core at (506, 170), radius 58, quiet (its `answer`
 * screen), and every state uses it. Only two states change it, because they say something the board does not:
 * `off` is dim and broken, and `recording` steps brighter with your voice.
 */
function answerCore(c: Canvas, mode: HackMode, t: number, level: number): void {
  if (mode === "off") return drawCore(c, 506, 170, 58, t, { look: DIM, slow: true, broken: true });
  if (mode === "recording") return drawCore(c, 506, 170, 58, t, { look: [QUIET, MID, BRIGHT][voiceStep(level)] ?? QUIET, slow: true });
  drawCore(c, 506, 170, 58, t, { look: QUIET, slow: true });
}

/** Draws the board's `hackos` screen for a HackScreen onto a lens canvas (576 x 288, last write wins). */
export function renderHackLens(c: Canvas, s: HackScreen, o: LensOptions): void {
  const level = o.level ?? 0;
  const reveal = o.reveal ?? 1;
  drawHeader(c, iconFrame(s.mode, o.t, level), o.clock);
  if (s.layout === "waking") {
    // The board's `waking`: the core at (100, 178), radius 76, lit by the seconds; the counter on the right.
    const sec = s.seconds;
    const n = Math.round((sec / 60) * 30);
    drawCore(c, 100, 178, 76, o.t, { look: BRIGHT, ring: true, lit: n });
    c.text(222, 92, "GPU COLD START", lv(0.5));
    c.text(222, 106, `0${sec}`.slice(-2), lv(1), 6, true);
    c.text(296, 141, "SEC", lv(0.6));
    for (let i = 0; i < 30; i++) c.p(222 + i * 8, 162, lv(i < n ? 1 : 0.25), 5, 5);
    c.text(222, 276, s.footer, lv(0.4));
    return;
  }
  if (reveal < 1) {
    drawBoot(c, 506, 170, 58, o.t, reveal);
    return;
  }
  if (s.bars) s.bars.forEach((h, i) => c.p(378 + i * 3, 21 - h, lv(0.7), 2, h));
  if (s.speed) c.textRight(502, 10, s.speed, lv(0.6));
  answerCore(c, s.mode, o.t, level);
  if (s.footer) c.text(0, 276, s.footer, lv(0.4));
}

/** One lens frame as pixels. */
export function renderHack(s: HackScreen, o: LensOptions): Uint8Array {
  const c = lensCanvas();
  renderHackLens(c, s, o);
  return c.pixels;
}

/** Frames a second for a state: 4 while the icon or the opening moves, 2 for a turning core, 0 when nothing moves. */
export function hackFps(s: HackScreen, reveal: number, spinning = true): number {
  if (s.layout === "answer" && reveal < 1) return 4;
  switch (s.mode) {
    case "recording":
    case "working":
      return 4;
    case "waking":
    case "answering":
      return 2;
    default:
      return spinning ? 2 : 0;
  }
}
