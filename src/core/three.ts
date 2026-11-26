import { Canvas, lv } from "./pixels";

/**
 * 3D for the glasses, drawn crisp. Depth is three flat light levels, dotted
 * lines for far edges and smaller marks for far points. Never soft edges.
 * Draw on a `new Canvas(w, h)`.
 */

export type Vec3 = [number, number, number];

/** Yaw about the vertical axis, then pitch. */
export function rotate(v: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = v[0] * cy + v[2] * sy;
  const z1 = -v[0] * sy + v[2] * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, v[1] * cp - z1 * sp, v[1] * sp + z1 * cp];
}

/** Perspective: k = 3.4 / (3.4 + z). z > 0 is away from the viewer; y points up on the model, down on the screen. */
export function project(v: Vec3, cx: number, cy: number, scale: number): { x: number; y: number; z: number } {
  const k = 3.4 / (3.4 + v[2]);
  return { x: cx + v[0] * scale * k, y: cy - v[1] * scale * k, z: v[2] };
}

export type Graph3 = { points: Vec3[]; links: [number, number][] };

/** A small seeded generator (mulberry32), so a layout is the same every time. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEPS = 90;
const REST = 0.3;

/**
 * Deterministic positions for `count` nodes inside the unit ball. Linked nodes
 * sit near each other, unlinked ones spread. A seeded start, then fixed
 * relaxation steps: springs along links, repulsion between all pairs. The
 * result is scaled so the outermost node is at radius 0.92.
 */
export function layoutGraph(count: number, links: [number, number][], seed = 7): Vec3[] {
  const random = rng(seed);
  const pos: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    // Rejection sampling keeps the start uniform in the ball.
    let v: Vec3;
    do v = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    while (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 1);
    pos.push(v);
  }
  if (count < 2) return pos.map(() => [0, 0, 0]);
  const valid = links.filter(([a, b]) => a !== b && a >= 0 && b >= 0 && a < count && b < count);
  for (let step = 0; step < STEPS; step++) {
    const force: Vec3[] = pos.map(() => [0, 0, 0]);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = pos[i] as Vec3;
        const b = pos[j] as Vec3;
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.02;
        const push = 0.0035 / d2;
        const fi = force[i] as Vec3;
        const fj = force[j] as Vec3;
        fi[0] += dx * push; fi[1] += dy * push; fi[2] += dz * push;
        fj[0] -= dx * push; fj[1] -= dy * push; fj[2] -= dz * push;
      }
    }
    for (const [i, j] of valid) {
      const a = pos[i] as Vec3;
      const b = pos[j] as Vec3;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      const pull = (0.12 * (d - REST)) / d;
      const fi = force[i] as Vec3;
      const fj = force[j] as Vec3;
      fi[0] += dx * pull; fi[1] += dy * pull; fi[2] += dz * pull;
      fj[0] -= dx * pull; fj[1] -= dy * pull; fj[2] -= dz * pull;
    }
    for (let i = 0; i < count; i++) {
      const p = pos[i] as Vec3;
      const f = force[i] as Vec3;
      // A weak pull to the centre stops separate clusters from drifting away.
      p[0] += f[0] - p[0] * 0.01;
      p[1] += f[1] - p[1] * 0.01;
      p[2] += f[2] - p[2] * 0.01;
      const r = Math.hypot(p[0], p[1], p[2]);
      if (r > 1) { p[0] /= r; p[1] /= r; p[2] /= r; }
    }
  }
  const reach = Math.max(...pos.map((p) => Math.hypot(p[0], p[1], p[2])), 1e-6);
  return pos.map((p) => [(p[0] / reach) * 0.92, (p[1] / reach) * 0.92, (p[2] / reach) * 0.92]);
}

export type GraphView = { cx: number; cy: number; scale: number; yaw: number; pitch: number };
/** The projected points of a graph, in node order. */
export type Projected = { x: number; y: number; z: number }[];
/**
 * `lit`: nodes drawn bright with bright links between them. `focus`: one node marked with a ring (also counts as lit).
 * `labels`: micro caps beside nodes. `vis`: which nodes and links are drawn at all, as a list by node or a function of
 * the projected points (the board's reveal); labels ignore it, as on the board.
 */
export type GraphStyle = {
  lit?: number[];
  focus?: number | null;
  labels?: Record<number, string>;
  vis?: readonly boolean[] | ((points: Projected) => readonly boolean[]);
};

/** Link and node light for depth: near, middle, far, as the board's alphas turned into levels. */
const LINK = { near: lv(0.45), mid: lv(0.3), far: lv(0.22) } as const;
const NODE = { near: lv(0.8), mid: lv(0.55), far: lv(0.45) } as const;
const LABEL = lv(0.85);

/**
 * Draws the graph, links first, then nodes, then labels, exactly as the board's `graph()` does.
 * Draw on a canvas with `over` set (see `lensCanvas`). Returns the projected points.
 */
export function drawGraph(canvas: Canvas, graph: Graph3, view: GraphView, style: GraphStyle = {}): Projected {
  const pts = graph.points.map((v) => project(rotate(v, view.yaw, view.pitch), view.cx, view.cy, view.scale));
  const focus = style.focus ?? null;
  const lit = new Set(style.lit ?? []);
  if (focus !== null) lit.add(focus);
  const vis = typeof style.vis === "function" ? style.vis(pts) : (style.vis ?? null);

  for (const [i, j] of graph.links) {
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    if (vis && (!vis[i] || !vis[j])) continue;
    if (lit.has(i) && lit.has(j)) {
      canvas.line(a.x, a.y, b.x, b.y, 255);
      continue;
    }
    const z = (a.z + b.z) / 2;
    if (z < -0.2) canvas.line(a.x, a.y, b.x, b.y, LINK.near);
    else if (z < 0.35) canvas.line(a.x, a.y, b.x, b.y, LINK.mid);
    else canvas.dashed(a.x, a.y, b.x, b.y, LINK.far, 1, 2);
  }

  pts.forEach((q, i) => {
    if (vis && !vis[i]) return;
    const x = Math.round(q.x);
    const y = Math.round(q.y);
    if (i === focus) {
      canvas.knockout(x, y, 9);
      canvas.rect(x - 2, y - 2, 5, 5, 255);
      canvas.circle(x, y, 8, 255);
      canvas.rect(x - 12, y, 3, 1, 255);
      canvas.rect(x + 10, y, 3, 1, 255);
      canvas.rect(x, y - 12, 1, 3, 255);
      canvas.rect(x, y + 10, 1, 3, 255);
    } else if (lit.has(i)) {
      canvas.clearRect(x - 3, y - 3, 7, 7);
      canvas.rect(x - 2, y - 2, 5, 5, 255);
    } else if (q.z < -0.3) canvas.rect(x - 1, y - 1, 3, 3, NODE.near);
    else if (q.z < 0.4) canvas.rect(x - 1, y - 1, 2, 2, NODE.mid);
    else canvas.plot(x, y, NODE.far);
  });

  for (const [key, text] of Object.entries(style.labels ?? {})) {
    const q = pts[Number(key)];
    if (q && text) canvas.label(q.x + 8, q.y - 3, text, LABEL);
  }
  return pts;
}
