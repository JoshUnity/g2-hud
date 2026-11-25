import { LENS, drawHeader, drawMeter, drawPages } from "../core/board";
import type { IconGrid } from "../core/icon";
import { Canvas, lv } from "../core/pixels";
import { drawGraph, type Projected } from "../core/three";
import type { Vault } from "./vault";

/**
 * The whole Answers lens as one raster, ported line by line from the board's engine (`test/board/hud.cjs`, the
 * `answers` screens `listening`, `recall` and `answer`, the helpers `hdr`, `meter`, `pages`, `graph` and
 * `vaultOpen`). Every coordinate, size and order of drawing is the board's. The glasses text is not here: it
 * sits in text containers (see view.ts and pages.ts).
 */

/** The ribbon has 73 columns, k = -36 to 36, on a 4 px pitch around x 288. */
export const RIBBON_HALF = 36;
export const RIBBON_COLUMNS = 2 * RIBBON_HALF + 1;

/** The recall view's graph: the person, the notes lit round them, and the card's data. */
export type RecallDraw = {
  vault: Vault;
  focus: number;
  /** Up to 3 linked nodes: lit and labelled. */
  linked: number[];
  name: string;
  /** "SEEN 12 NOV" at the right of the card's top row, or absent. */
  seen: string | null;
  /** The card's labels for the lines under the name: present when that line is. */
  hasLast: boolean;
  hasOpen: boolean;
  /** The entrance, 0 to 1 (1 is the board's picture). */
  entrance: number;
};

/** The source orb of an answer. */
export type SourcesDraw = { vault: Vault; lit: number[]; count: number; titles: string[] };

export type LensModel = {
  /** The pixel clock at the right of the header, "18:16". */
  clock: string;
  /** The 12 x 12 icon with `#` lit, `+` dim. */
  icon: IconGrid;
  /** The five meter levels 0 to 1, or null when the meter is not shown. */
  meter: readonly number[] | null;
  view: "listening" | "recall" | "answer" | "plain";
  /** Listening: the ribbon's column heights (0 to 5 rows each side of the baseline), or its dim baseline. */
  ribbon: { columns: readonly number[]; dim: boolean } | null;
  /** The opening ("the vault comes online"): progress r, and the notes and people counts of the vault. */
  open: { r: number; vault: Vault | null } | null;
  recall: RecallDraw | null;
  sources: SourcesDraw | null;
  /** The page squares of an answer with several pages. */
  pages: { count: number; current: number } | null;
};

/** Where the page squares start: the board's 458 for two pages, ending 6 px before the meter. */
export const pagesX = (count: number): number => 478 - 10 * count;

/** The micro caps of a title: upper case, at most 18 characters. */
export const labelText = (title: string): string => title.toUpperCase().slice(0, 18).trimEnd();

/** The board's `vis` for a reveal: the farthest nodes first (`share` of them), minus a fixed scattered `thin` share. */
export function depthVis(share: number, thin = 0): (points: Projected) => boolean[] {
  return (points) => {
    const n = points.length;
    const order = points.map((_, i) => i).sort((a, b) => (points[b]?.z ?? 0) - (points[a]?.z ?? 0));
    const visible: boolean[] = [];
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      visible[i] = k < share * n && !(thin > 0 && ((i * 7) % 13) / 13 < thin);
    }
    return visible;
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The opening's phases: the vault builds from r 0.08 over 0.6, holds, then thins out from r 0.82. */
export const OPEN_BUILD_FROM = 0.08;
export const OPEN_BUILD_OVER = 0.6;
export const OPEN_OUT = 0.82;
export const OPEN_RIBBON = 0.25;
export const openShare = (r: number): number => clamp01((r - OPEN_BUILD_FROM) / OPEN_BUILD_OVER);

/** The board's `vaultOpen`, with the counts of the vault when it has them. */
function drawVaultOpen(c: Canvas, vault: Vault, r: number, t: number): void {
  const q = openShare(r);
  const d = r > OPEN_OUT ? (r - OPEN_OUT) / (1 - OPEN_OUT) : 0;
  drawGraph(c, vault.graph, { cx: 150, cy: 108, scale: 60, yaw: t * 0.5, pitch: 0.36 }, { lit: [], vis: depthVis(q, d) });
  if (d >= 0.6) return;
  c.text(330, 88, "VAULT ONLINE", lv(0.5));
  const total = vault.total;
  if (!total) return;
  const count = String(Math.round(total.notes * q));
  // The words follow the vault's own totals (the board's are "NOTES" and "PEOPLE"), not the running count.
  c.textRight(560, 88, `${Math.round(total.people * q)} ${total.people === 1 ? "PERSON" : "PEOPLE"}`, lv(0.5));
  c.text(330, 100, count, lv(1), 6, true);
  c.text(338 + Canvas.textWidth(count, 6), 135, total.notes === 1 ? "NOTE" : "NOTES", lv(0.6));
}

/** The board's ribbon: for each column k, n rows above and below the baseline at y 176, each 2 x 2 on a 4 px pitch. */
function drawRibbon(c: Canvas, columns: readonly number[], dim: boolean, reach: number): void {
  for (let k = -reach; k <= reach; k++) {
    const n = dim ? 0 : Math.round(columns[k + RIBBON_HALF] ?? 0);
    for (let j = -n; j <= n; j++) {
      const a = dim ? 0.35 : j === 0 ? 0.9 : 0.9 - Math.abs(j) * 0.13;
      c.p(288 + k * 4, 176 + j * 4, lv(a), 2, 2);
    }
  }
}

/** The recall entrance: the cloud assembles first, then the ring and the lit links, then the labels and the leader. */
export const ENTRANCE_MS = 900;
export const ENTRANCE_CLOUD = 0.6;
export const ENTRANCE_LABELS = 0.8;

/** The board's recall screen, drawing the graph, the leader, the divider and the card's micro text and name. */
function drawRecall(c: Canvas, r: RecallDraw, t: number): void {
  const e = r.entrance;
  const view = { cx: 142, cy: 168, scale: 92, yaw: t * 0.22, pitch: 0.36 + 0.08 * Math.sin(t * 0.3) };
  const labels: Record<number, string> = {};
  if (e >= ENTRANCE_LABELS) for (const i of r.linked) labels[i] = labelText(r.vault.nodes[i]?.title ?? "");
  const style =
    e < ENTRANCE_CLOUD
      ? { lit: [], focus: null, vis: depthVis(e / ENTRANCE_CLOUD) }
      : { lit: r.linked, focus: r.focus, labels };
  const pts = drawGraph(c, r.vault.graph, view, style);
  const f = pts[r.focus];
  if (f && e >= ENTRANCE_LABELS) {
    c.dashed(f.x, f.y - 13, f.x, 46, lv(0.6), 1, 2);
    c.dashed(f.x, 46, 298, 46, lv(0.6), 1, 2);
  }
  c.dashed(294, 52, 294, 286, lv(0.3), 1, 3);
  c.text(304, 42, "PERSON", lv(0.5));
  if (r.seen) c.textRight(LENS.width, 42, `SEEN ${r.seen}`, lv(0.5));
  const name = nameFit(r.name);
  c.text(304, 56, name.text, lv(1), name.scale, name.dots);
  if (r.hasLast) c.text(304, 146, "LAST MEETING", lv(0.5));
  if (r.hasOpen) c.text(304, 190, "OPEN", lv(0.5));
  const total = r.vault.total;
  if (total) c.text(304, 276, `VAULT  ${total.notes} ${total.notes === 1 ? "NOTE" : "NOTES"}  ·  ${total.people} ${total.people === 1 ? "PERSON" : "PEOPLE"}`, lv(0.4));
}

const NAME_WIDTH = 264;

/** The name as the hero: dots at scale 3, or scale 2 without dots and cut with "..." when it does not fit 264 px. */
export function nameFit(name: string): { text: string; scale: number; dots: boolean } {
  const upper = name.toUpperCase();
  if (Canvas.textWidth(upper, 3) <= NAME_WIDTH) return { text: upper, scale: 3, dots: true };
  let text = upper;
  while (text.length > 1 && Canvas.textWidth(text, 2) > NAME_WIDTH) text = text.slice(0, -1);
  return { text: text === upper ? upper : text.slice(0, -3).trimEnd() + "...", scale: 2, dots: false };
}

/** The board's answer screen: the page squares, then the source orb with its caption. */
function drawSources(c: Canvas, s: SourcesDraw, t: number): void {
  drawGraph(c, s.vault.graph, { cx: 510, cy: 112, scale: 40, yaw: t * 0.3, pitch: 0.4 }, { focus: null, lit: s.lit });
  c.textCenter(510, 170, `FROM ${s.count} ${s.count === 1 ? "NOTE" : "NOTES"}`, lv(0.6));
  s.titles.forEach((title, i) => c.textCenter(510, 184 + i * 10, labelText(title), lv(0.4)));
}

/** Draws the lens at time `t` (seconds) onto a canvas from `lensCanvas()`. */
export function drawLens(c: Canvas, m: LensModel, t: number): void {
  drawHeader(c, m.icon, m.clock);
  if (m.view === "answer" && m.pages) drawPages(c, pagesX(m.pages.count), m.pages.count, m.pages.current);
  if (m.meter) drawMeter(c, 484, m.meter);
  if (m.view === "recall" && m.recall) drawRecall(c, m.recall, t);
  else if (m.view === "answer" && m.sources) drawSources(c, m.sources, t);
  else if (m.view === "listening" || m.view === "plain") {
    const r = m.open?.r ?? 1;
    if (m.open && m.open.vault && r < 1) drawVaultOpen(c, m.open.vault, r, t);
    if (m.ribbon) {
      const reach = m.open && r < 1 ? Math.round(RIBBON_HALF * Math.min(1, r / OPEN_RIBBON)) : RIBBON_HALF;
      drawRibbon(c, m.ribbon.columns, m.ribbon.dim, reach);
    }
  }
}

/** How often the lens needs a new frame: 0 while nothing moves, 2 when a moving part crosses tile borders, else 4. */
export function lensFps(m: LensModel, animated: { icon: boolean; meter: boolean }): number {
  if (m.view === "recall" || m.sources || (m.open && m.open.r < 1)) return 2;
  if (m.ribbon && !m.ribbon.dim) return 2;
  return animated.icon || animated.meter ? 4 : 0;
}

/** A model's picture, for tests and for the page. */
export function renderLens(canvas: Canvas, m: LensModel, t: number): Uint8Array {
  drawLens(canvas, m, t);
  return canvas.pixels;
}
