import { LENS, drawHeader, drawTabs, type TabState } from "../core/board";
import { GLYPHS } from "../core/font5x7";
import { Canvas, lv } from "../core/pixels";
import { project, rotate, type Vec3 } from "../core/three";
import { iconFrame, type IconState } from "./glyph";

/**
 * The whole Code lens as one 576 x 288 raster, ported line by line from the board (`test/board/hud.cjs`:
 * `code.working`, `code.allow`, `wgraph`). Every coordinate, size, pattern and order of drawing is the board's.
 * The glasses font (the prompt, the steps, the call, the hint) is not drawn here: it sits in text containers.
 */

// ---- The file map (the board's `WK` and `wgraph`) -------------------------------------------

export type MapMark = {
  node: number;
  /** edit = solid square, read = hollow square, current = solid with a pulsing ring. */
  kind: "edit" | "read" | "current";
  /** Micro caps beside the mark; "" for none. */
  label: string;
  dy: number;
  /** The label's alpha, as in the board. */
  alpha: number;
  /** Extra distance of the label from its node. */
  ex: number;
};

export type MapModel = {
  project: string;
  points: Vec3[];
  edges: [number, number][];
  /** The node numbers of the folders. */
  folders: number[];
  /** The folders that hold a touched file are drawn bright. */
  hotFolders: number[];
  /** Edges drawn solid and bright once the marks are in ("a-b"). */
  hot: string[];
  marks: MapMark[];
};

/** The board's generator (`rng(21)`): the same numbers in the same order. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, to place a file that has no free slot on its folder. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  return h >>> 0;
}

/** Folders on a ring, at these heights (the board's `[.38,-.42,.46,-.3]`). */
const HEIGHTS = [0.38, -0.42, 0.46, -0.3] as const;
/** The board has 5 file dots on a folder. */
export const DOTS = 5;
/** The label places of the board's three marks, oldest to newest: (dy, alpha, ex). */
const SLOTS = [
  { dy: -13, alpha: 0.9, ex: 0 },
  { dy: 6, alpha: 0.7, ex: 0 },
  { dy: -3, alpha: 1, ex: 5 },
] as const;
export const LABEL_CHARS = 18;

export type MapFile = { path: string; state: "read" | "edit" };

/** The label of a path: without its top folder, the last two segments in micro caps, with only characters the 5 x 7 font has, cut to LABEL_CHARS. */
export function mapLabel(path: string): string {
  const parts = path.split("/");
  const text = (parts.length > 1 ? parts.slice(1) : parts).slice(-2).join("/").toUpperCase().replace(/_/g, "-");
  return [...text].filter((ch) => GLYPHS[ch] !== undefined).join("").slice(0, LABEL_CHARS);
}

/**
 * The board's `WK` generalised to a real project: the root, one node per folder on a ring (the board's angles,
 * heights and radius), and up to 5 file dots around each folder from one seeded generator. A touched file takes a
 * dot of its folder (a root file, or one with no free dot, hangs beside it). With 4 folders of 5 files or more this is
 * exactly the board's `WK`.
 */
export function buildMap(project: string, tree: readonly { name: string; files: number }[], files: readonly MapFile[], current: string | null): MapModel {
  const r = rng(21);
  const points: Vec3[] = [[0, 0, 0]];
  const edges: [number, number][] = [];
  const folders: number[] = [];
  const hot = new Set<string>();
  const hotFolders: number[] = [];
  const nodeOf = new Map<string, number>();
  const folderOf = (path: string): number => {
    const first = path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
    return tree.findIndex((f) => f.name === first);
  };
  const touched = [...files];
  const inFolder = tree.map((_, d) => touched.filter((f) => folderOf(f.path) === d));
  tree.forEach((folder, d) => {
    const a = (d * Math.PI * 2) / tree.length + 0.4;
    const dp: Vec3 = [Math.cos(a) * 0.8, HEIGHTS[d % HEIGHTS.length] ?? 0, Math.sin(a) * 0.8];
    points.push(dp);
    const di = points.length - 1;
    folders.push(di);
    edges.push([0, di]);
    const slots = Array.from({ length: DOTS }, () => {
      const u = r() * 6.283;
      const v = (r() - 0.5) * 1.6;
      return [dp[0] + Math.cos(u) * 0.42 * Math.cos(v), dp[1] + Math.sin(v) * 0.42, dp[2] + Math.sin(u) * 0.42 * Math.cos(v)] as Vec3;
    });
    const mine = inFolder[d] ?? [];
    const used = Math.max(Math.min(DOTS, folder.files), Math.min(DOTS, mine.length));
    for (let k = 0; k < used; k++) {
      points.push(slots[k] ?? dp);
      edges.push([di, points.length - 1]);
      const file = mine[k];
      if (file) nodeOf.set(file.path, points.length - 1);
    }
    if (mine.length > 0) {
      hotFolders.push(di);
      hot.add(`0-${di}`);
    }
    for (const file of mine.slice(DOTS)) {
      const q = rng(hash(file.path));
      const u = q() * 6.283;
      const v = (q() - 0.5) * 1.6;
      points.push([dp[0] + Math.cos(u) * 0.3 * Math.cos(v), dp[1] + Math.sin(v) * 0.3, dp[2] + Math.sin(u) * 0.3 * Math.cos(v)]);
      edges.push([di, points.length - 1]);
      nodeOf.set(file.path, points.length - 1);
    }
  });
  // Files of the project root, or of a folder the tree does not list, hang on the root.
  for (const file of touched.filter((f) => folderOf(f.path) < 0)) {
    const q = rng(hash(file.path));
    const u = q() * 6.283;
    const v = (q() - 0.5) * 1.6;
    points.push([Math.cos(u) * 0.5 * Math.cos(v), Math.sin(v) * 0.4, Math.sin(u) * 0.5 * Math.cos(v)]);
    edges.push([0, points.length - 1]);
    nodeOf.set(file.path, points.length - 1);
    hot.add(`0-${points.length - 1}`);
  }
  for (const file of touched) {
    const node = nodeOf.get(file.path);
    const d = folderOf(file.path);
    if (node !== undefined && d >= 0) hot.add(`${folders[d]}-${node}`);
  }
  // The newest touched files carry the labels; the current file comes last, so its ring is drawn on top.
  const order = touched.filter((f) => f.path !== current);
  const now = touched.find((f) => f.path === current);
  if (now) order.push(now);
  const marks: MapMark[] = order.flatMap((file, i) => {
    const node = nodeOf.get(file.path);
    if (node === undefined) return [];
    const rank = order.length - 1 - i; // 0 = the newest
    const slot = rank < SLOTS.length ? SLOTS[SLOTS.length - 1 - rank] : undefined;
    return [
      {
        node,
        kind: file.path === current ? ("current" as const) : file.state,
        label: slot ? mapLabel(file.path) : "",
        dy: slot?.dy ?? 0,
        alpha: slot?.alpha ?? 1,
        ex: slot?.ex ?? 0,
      },
    ];
  });
  return { project: mapLabel(project || "project"), points, edges, folders, hotFolders, hot: [...hot], marks };
}

const grow = (rv: number, from: number, span: number): number => Math.max(0, Math.min(1, (rv - from) / span));

/** The board's `wgraph(cx, cy, sc, yaw, rv)`. `marks` false is the map at rest: no touched files, no labels but the name. */
export function drawMap(c: Canvas, m: MapModel, cx: number, cy: number, sc: number, yaw: number, t: number, rv = 1, marksOn = true): void {
  const P = m.points.map((n) => project(rotate(n, yaw, 0.36), cx, cy, sc));
  const isFolder = new Set(m.folders);
  const fr = (i: number): number => (i === 0 ? 1 : grow(rv, isFolder.has(i) ? 0.08 : 0.42, isFolder.has(i) ? 0.34 : 0.36));
  const marked = new Set(marksOn ? m.marks.map((k) => k.node) : []);
  const hot = new Set(marksOn ? m.hot : []);
  const marksIn = marksOn && rv >= 0.86;
  for (const [a, b] of m.edges) {
    const A = P[a];
    const B = P[b];
    const f = fr(b);
    if (!A || !B || !f) continue;
    const z = (A.z + B.z) / 2;
    const ex = A.x + (B.x - A.x) * f;
    const ey = A.y + (B.y - A.y) * f;
    if (marksIn && hot.has(`${a}-${b}`)) c.line(A.x, A.y, ex, ey, 255);
    else c.dashed(A.x, A.y, ex, ey, lv(z < 0 ? 0.35 : 0.25), 1, 2);
  }
  P.forEach((q, i) => {
    if (fr(i) < 1) return;
    if (i === 0 || (marksIn && marked.has(i))) return;
    if (isFolder.has(i)) c.p(q.x - 1, q.y - 1, lv(marksOn && m.hotFolders.includes(i) ? 1 : 0.6), 3, 3);
    else c.p(q.x - 1, q.y - 1, lv(q.z < 0 ? 0.6 : 0.4), 2, 2);
  });
  const root = P[0];
  if (!root) return;
  c.knockout(root.x, root.y, 7);
  c.circle(root.x, root.y, 6, 255);
  c.p(root.x - 1, root.y - 1, 255, 3, 3);
  c.label(root.x - Math.floor(Canvas.textWidth(m.project) / 2), root.y + 11, m.project, lv(0.6));
  if (rv < 0.86) {
    c.label(cx - 44, cy + 70, MOUNT_LABEL, lv(0.6));
    return;
  }
  if (!marksOn) return;
  const lab = (s: string, q: { x: number }, y: number, a: number, dy: number, ex: number): void => {
    if (!s) return;
    const o = 9 + ex;
    c.label(q.x > cx + 20 ? q.x - o - Canvas.textWidth(s) : q.x + o, y + dy, s, lv(a));
  };
  for (const k of m.marks) {
    const q = P[k.node];
    if (!q) continue;
    if (k.kind === "current") {
      const rp = 7 + (Math.floor(t * 4) % 4);
      c.knockout(q.x, q.y, 10);
      c.p(q.x - 2, q.y - 2, 255, 5, 5);
      c.circle(q.x, q.y, rp, lv(rp > 8 ? 0.5 : 1));
    } else {
      c.clearRect(q.x - 4, q.y - 4, 9, 9);
      if (k.kind === "edit") c.p(q.x - 3, q.y - 3, 255, 7, 7);
      else c.box(q.x - 3, q.y - 3, 7, 7, 255);
    }
    lab(k.label, q, q.y, k.alpha, k.dy, k.ex);
  }
}

export const MOUNT_LABEL = "MAPPING PROJECT";
/** The opening of the map (the board's `RV`): how long it runs. */
export const MOUNT_MS = 2400;

// ---- The lens ---------------------------------------------------------------------------------

/**
 * What the raster shows. `live`: the working screen. `rest`: the file map at rest. `approval`: the card.
 * `blank`: only the header, so no picture sits under the text of a result or a message.
 */
export type LensModel = {
  scene: "live" | "rest" | "approval" | "blank";
  icon: IconState;
  /** The voice level (0 to 1) for the recording icon. */
  level: number;
  clock: string;
  tabs: TabState[];
  /** Step rows (0 to MAX_ROWS); the last one is the current step. */
  rows: number;
  /** The elapsed time, `m:ss`. */
  elapsed: string;
  steps: { count: number; atLeast: boolean };
  files: { count: number; atLeast: boolean };
  /** Lines added and removed; null leaves the line and its bar out. */
  diff: { added: number; removed: number } | null;
  map: MapModel;
  /** The approval card: the tool tag (null leaves it out), the network note, and the seconds left. */
  tag: string | null;
  network: boolean;
  remaining: number;
};

/** Step rows that fit between the prompt and the timer (y 100 to 208). */
export const MAX_ROWS = 4;
/** The board's gate on the steps while the map opens. */
export const rowShown = (i: number, rv: number): boolean => !(rv < 1 && rv < 0.3 + i * 0.22);

/** The tab squares end at x 494, the board's `tabs(462)` for 3 tabs. */
export const tabsX = (count: number): number => 494 - 8 - 12 * (Math.max(1, count) - 1);

/** `m:ss`; minutes keep counting past 59. */
export const clockMs = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** The board's `code.working`, then `code.allow`. `rv` is the map's opening progress (1 when it is not opening). */
export function renderCodeLens(c: Canvas, m: LensModel, t: number, rv = 1): void {
  drawHeader(c, iconFrame(m.icon, t, m.level), m.clock);
  if (m.tabs.length > 0) drawTabs(c, tabsX(m.tabs.length), m.tabs);
  if (m.scene === "approval") {
    c.roundRect(0, 76, LENS.width, 96, 6, 255);
    if (m.tag) {
      c.p(16, 70, 255, Canvas.textWidth(m.tag) + 12, 13);
      c.text(21, 73, m.tag, 0);
    }
    if (m.network) c.textRight(556, 88, "NEEDS NETWORK", lv(0.5));
    const w = Math.round((496 * m.remaining) / 120);
    c.p(0, 186, 255, w, 2);
    for (let i = w + 2; i < 496; i += 4) c.p(i, 186, lv(0.4), 1, 2);
    c.textRight(LENS.width, 180, `${Math.floor(m.remaining / 60)}:${("0" + (m.remaining % 60)).slice(-2)}`, lv(0.9), 2);
    return;
  }
  if (m.scene === "blank") return;
  if (m.scene === "live") {
    if (m.rows > 1) c.dashed(5, 112, 5, 100 + 27 * (m.rows - 1) + 12, lv(0.4), 1, 2);
    for (let i = 0; i < m.rows; i++) {
      if (!rowShown(i, rv)) continue;
      const y = 100 + i * 27;
      if (i < m.rows - 1) {
        c.clearRect(2, y + 10, 7, 7);
        c.p(3, y + 11, lv(0.6), 5, 5);
      } else {
        c.clearRect(1, y + 9, 9, 9);
        c.box(2, y + 10, 7, 7, 255);
        c.p(4, y + 12, lv(Math.floor(t * 3) % 2 ? 1 : 0.3), 3, 3);
      }
    }
    c.text(0, 206, "ELAPSED", lv(0.5));
    c.text(0, 218, m.elapsed, 255, 4, true);
    const side = Math.max(110, Canvas.textWidth(m.elapsed, 4) + 18);
    c.text(side, 220, `${m.steps.count}${m.steps.atLeast ? "+" : ""} ${m.steps.count === 1 && !m.steps.atLeast ? "STEP" : "STEPS"}`, lv(0.6));
    c.text(side, 231, `${m.files.count}${m.files.atLeast ? "+" : ""} ${m.files.count === 1 && !m.files.atLeast ? "FILE" : "FILES"}`, lv(0.6));
    if (m.diff) {
      const text = `+${m.diff.added} -${m.diff.removed}`;
      c.text(side, 242, text, lv(0.6));
      const total = m.diff.added + m.diff.removed;
      if (total > 0) {
        const lit = Math.round((m.diff.added / total) * 7);
        const x0 = side + Canvas.textWidth(text) + 7;
        for (let i = 0; i < 7; i++) c.p(x0 + i * 6, 242, lv(i < lit ? 0.9 : 0.3), 4, 7);
      }
    }
  }
  // The board's divider runs to y 286. Where the hint is shown (the map at rest) it stops above the hint's row at y 255.
  c.dashed(294, 36, 294, m.scene === "rest" ? 252 : 286, lv(0.3), 1, 3);
  if (m.scene === "live") drawMap(c, m.map, 430, 160, 84, t * 0.25, t, rv);
  else drawMap(c, m.map, 430, 160, 84, 0.3, 0, rv, false);
}
