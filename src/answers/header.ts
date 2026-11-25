import type { IconGrid } from "../core/icon";
import { ICON } from "./icon";

export type IconMode = "connecting" | "listening" | "paused" | "thinking" | "answer" | "error" | "saved";

const CORE = (row: number, col: number): boolean => row >= 3 && row <= 8 && col >= 3 && col <= 8;
const CENTRE = 5.5;
const dist = (row: number, col: number): number => Math.hypot(row - CENTRE, col - CENTRE);

type Cell = { row: number; col: number };
const cells = (test: (row: number, col: number) => boolean): Cell[] =>
  ICON.flatMap((line, row) => [...line].flatMap((char, col) => (char === "#" && test(row, col) ? [{ row, col }] : [])));

/** The ring cells, clockwise from the top. */
const RING: Cell[] = cells((r, c) => !CORE(r, c)).sort((a, b) => angle(a) - angle(b));
function angle({ row, col }: Cell): number {
  const g = Math.atan2(col - CENTRE, CENTRE - row);
  return g < 0 ? g + Math.PI * 2 : g;
}

const GRID = (set: (row: number, col: number, char: string) => string): IconGrid =>
  ICON.map((line, row) => [...line].map((char, col) => (char === "." ? "." : set(row, col, char))).join(""));

/** Seconds of the breath: the outer core cells go dim every other period. */
const BREATH_S = 0.8;
/** The saved flash: dark for a beat, then fully lit. */
const FLASH_OFF_S = 0.12;
export const FLASH_S = 0.5;
/** The thinking arc: 8 ring cells, running round at about 14 cells a second. */
const ARC = 8;
const ARC_SPEED = 14;

/** The 12 x 12 grid for a state at time `t` (seconds), `since` the state began, and the voice `level` (0 to 1). */
export function iconFrame(mode: IconMode, t: number, since: number, level: number): IconGrid {
  if (mode === "saved" && since < FLASH_S) return since < FLASH_OFF_S ? GRID(() => ".") : GRID(() => "#");
  if (mode === "listening" || mode === "saved") {
    const dim = Math.floor(t / BREATH_S) % 2 === 1;
    // A louder voice lights the core from the middle outwards, so the icon grows with it.
    const reach = 0.8 + Math.max(0, Math.min(1, level)) * 3;
    return GRID((r, c, ch) => (CORE(r, c) && dim && dist(r, c) > reach ? "+" : ch));
  }
  if (mode === "answer") return GRID((_r, _c, ch) => ch);
  if (mode === "paused") return GRID((r, c, ch) => (CORE(r, c) ? "." : ch));
  if (mode === "thinking") {
    const head = Math.floor(t * ARC_SPEED) % RING.length;
    const lit = new Set<string>();
    for (let k = 0; k < ARC; k++) {
      const cell = RING[(head - k + RING.length) % RING.length];
      if (cell) lit.add(`${cell.row},${cell.col}`);
    }
    return GRID((r, c, ch) => (CORE(r, c) || lit.has(`${r},${c}`) ? ch : "+"));
  }
  // connecting and error: all dim; on error every third ring cell is off.
  const off = new Set(mode === "error" ? RING.filter((_, i) => i % 3 === 0).map((cell) => `${cell.row},${cell.col}`) : []);
  return GRID((r, c) => (off.has(`${r},${c}`) ? "." : "+"));
}

/** Recent voice levels, newest first. Fed by the audio frames (about 10 a second). */
export class Voice {
  readonly history: number[] = new Array<number>(40).fill(0);

  push(level: number): void {
    this.history.pop();
    this.history.unshift(Math.max(0, Math.min(1, level)));
  }

  /** A short average of the newest samples, for the icon. */
  get level(): number {
    return ((this.history[0] ?? 0) + (this.history[1] ?? 0) + (this.history[2] ?? 0)) / 3;
  }

  get active(): boolean {
    return this.history.some((v) => v > 0.02);
  }
}

/** The icon moves by itself in these states: the breath, the arc and the flash. */
export const iconMoves = (mode: IconMode): boolean => mode === "listening" || mode === "thinking" || mode === "saved";

/** The meter's five levels: the newest five voice samples, the newest at the right. */
export function meterOf(history: readonly number[]): number[] {
  return [4, 3, 2, 1, 0].map((i) => history[i] ?? 0);
}
