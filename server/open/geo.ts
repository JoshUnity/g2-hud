import { metresBetween } from "../../src/core/geo";

export type LL = [number, number];

/** Rounds to 5 decimals (about 1 m), which keeps the map messages small. */
export const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

const toXY = (origin: LL, p: LL): [number, number] => [
  (p[1] - origin[1]) * 111_320 * Math.cos((origin[0] * Math.PI) / 180),
  (p[0] - origin[0]) * 110_540,
];

/** Distance from point `p` to segment a-b in metres, with the nearest point on it. */
function toSegment(p: LL, a: LL, b: LL): { m: number; at: LL } {
  const [px, py] = toXY(p, p);
  const [ax, ay] = toXY(p, a);
  const [bx, by] = toXY(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { m: Math.hypot(ax + t * dx - px, ay + t * dy - py), at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

/** Distance from `p` to a polyline (or a single point) in metres, with the nearest point on it. */
export function nearestOnPath(p: { lat: number; lon: number }, path: LL[]): { m: number; at: LL } | null {
  const here: LL = [p.lat, p.lon];
  let best: { m: number; at: LL } | null = null;
  if (path.length === 1) return { m: metresBetween(p, { lat: path[0]![0], lon: path[0]![1] }), at: path[0]! };
  for (let i = 0; i + 1 < path.length; i++) {
    const hit = toSegment(here, path[i]!, path[i + 1]!);
    if (!best || hit.m < best.m) best = hit;
  }
  return best;
}

/** Douglas-Peucker: drops points closer than `tolM` metres to the line that remains. Keeps the ends. */
export function simplify(points: LL[], tolM: number): LL[] {
  if (points.length <= 2) return points;
  const origin = points[0]!;
  const xy = points.map((p) => toXY(origin, p));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    const [ax, ay] = xy[lo]!;
    const [bx, by] = xy[hi]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let farD = tolM;
    for (let i = lo + 1; i < hi; i++) {
      const [x, y] = xy[i]!;
      const d = len === 0 ? Math.hypot(x - ax, y - ay) : Math.abs(dy * (x - ax) - dx * (y - ay)) / len;
      if (d > farD) {
        far = i;
        farD = d;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// ---- Clipping to a rectangle in metres round a centre -------------------------

export type Rect = { west: number; east: number; south: number; north: number };
type XY = [number, number];

/** Converts to and from metres east and north of `c`. */
export function frame(c: { lat: number; lon: number }) {
  const kx = 111_320 * Math.cos((c.lat * Math.PI) / 180);
  return {
    toXY: (p: LL): XY => [(p[1] - c.lon) * kx, (p[0] - c.lat) * 110_540],
    toLL: ([x, y]: XY): LL => [round5(c.lat + y / 110_540), round5(c.lon + x / kx)],
  };
}

/** The part of segment a-b inside the rectangle (Liang-Barsky), or null. */
function clipSegment(a: XY, b: XY, r: Rect): [XY, XY] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - r.west],
    [dx, r.east - a[0]],
    [-dy, a[1] - r.south],
    [dy, r.north - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

/** A line cut to the rectangle: the pieces inside, each with at least two points. A line that leaves and comes back gives two. */
export function clipLine(points: XY[], r: Rect): XY[][] {
  const pieces: XY[][] = [];
  let cur: XY[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = clipSegment(points[i]!, points[i + 1]!, r);
    if (!seg) {
      if (cur.length) pieces.push(cur);
      cur = [];
      continue;
    }
    const [a, b] = seg;
    if (cur.length && (cur.at(-1)![0] !== a[0] || cur.at(-1)![1] !== a[1])) {
      pieces.push(cur);
      cur = [];
    }
    if (!cur.length) cur.push(a);
    cur.push(b);
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}

/** A polygon cut to the rectangle (Sutherland-Hodgman), closed; empty when nothing is inside. */
export function clipRing(ring: XY[], r: Rect): XY[] {
  let out = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : [...ring];
  const edges: { inside: (p: XY) => boolean; cut: (a: XY, b: XY) => XY }[] = [
    { inside: (p) => p[0] >= r.west, cut: (a, b) => [r.west, a[1] + ((b[1] - a[1]) * (r.west - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= r.east, cut: (a, b) => [r.east, a[1] + ((b[1] - a[1]) * (r.east - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= r.south, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (r.south - a[1])) / (b[1] - a[1]), r.south] },
    { inside: (p) => p[1] <= r.north, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (r.north - a[1])) / (b[1] - a[1]), r.north] },
  ];
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!;
      const b = input[(i + 1) % input.length]!;
      if (e.inside(b)) {
        if (!e.inside(a)) out.push(e.cut(a, b));
        out.push(b);
      } else if (e.inside(a)) out.push(e.cut(a, b));
    }
    if (!out.length) return [];
  }
  return out.length >= 3 ? [...out, out[0]!] : [];
}

/** Area of a closed ring in square metres. */
export function areaM2(ring: XY[]): number {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return Math.abs(s) / 2;
}

export const lengthM = (line: XY[]): number => line.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - line[i - 1]![0], p[1] - line[i - 1]![1]) : 0), 0);
