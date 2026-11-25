import type { Box } from "./box";
import type { Producer } from "./imagepipe";
import { Canvas, lv } from "./pixels";

/**
 * One 12 x 12 cell bitmap per app, used three ways: the store icon (each cell
 * 2 x 2 px), the header icon (the same size, animated by state) and the launch
 * intro (each cell a 6 x 6 square on an 8 px pitch). See DESIGN.md, "Icons".
 */

export const ICON_CELLS = 12;

/** 12 rows of 12 characters: `#` lit, `+` dim, `.` off. */
export type IconGrid = readonly string[];

/** When, from 0 to 1, the cell at (row, col) lights up in the launch intro. */
export type IconOrder = (row: number, col: number) => number;

/** Throws a readable error when the grid is not 12 x 12 of `#`, `+` and `.`. */
export function checkIconGrid(grid: IconGrid): void {
  if (grid.length !== ICON_CELLS) throw new Error(`icon needs ${ICON_CELLS} rows, found ${grid.length}.`);
  grid.forEach((row, y) => {
    if (row.length !== ICON_CELLS) throw new Error(`icon row ${y + 1} needs ${ICON_CELLS} characters, found ${row.length}.`);
    [...row].forEach((char, x) => {
      if (char !== "#" && char !== "+" && char !== ".") throw new Error(`icon row ${y + 1}, column ${x + 1}: use "#", "+" or ".", found "${char}".`);
    });
  });
}

/** Draws each lit cell as a (cell - gap) square at pitch `cell`; dim cells use the `dim` value (the board's 0.4, level 6). */
export function drawIcon(canvas: Canvas, grid: IconGrid, x: number, y: number, cell: number, gap = 0, lit = 255, dim = lv(0.4)): void {
  checkIconGrid(grid);
  grid.forEach((row, cy) => {
    [...row].forEach((char, cx) => {
      if (char === ".") return;
      canvas.rect(x + cx * cell, y + cy * cell, cell - gap, cell - gap, char === "#" ? lit : dim);
    });
  });
}

/** A square frame of 12 * cell pixels, ready for an image container. */
export function renderIcon(grid: IconGrid, cell = 2, gap = 0): Uint8Array {
  const size = ICON_CELLS * cell;
  const canvas = new Canvas(size, size);
  drawIcon(canvas, grid, 0, 0, cell, gap);
  return canvas.pixels;
}

/**
 * The animated header icon, as an image producer.
 * An app gives a frame function (the grid for a mode at a time) and a frame rate
 * function, and sets the mode as its state changes.
 */
export class IconMark<M extends string> {
  private modeAt = performance.now();
  private level = 0;
  private target = 0;

  constructor(
    private readonly box: Box,
    private readonly frame: (mode: M, t: number, since: number, level: number) => IconGrid,
    private readonly fps: (mode: M, since: number, level: number) => number,
    private mode: M,
  ) {}

  setMode(mode: M): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeAt = performance.now();
  }

  /** Voice level from 0 to 1; smoothed, so the icon swells and does not twitch. */
  setLevel(level: number): void {
    this.target = Math.max(this.target, Math.max(0, Math.min(1, level)));
  }

  producer(): Producer {
    return {
      box: this.box,
      fps: () => this.fps(this.mode, (performance.now() - this.modeAt) / 1000, this.level),
      render: (t) => {
        this.level += (this.target - this.level) * 0.35;
        this.target *= 0.8;
        return renderIcon(this.frame(this.mode, t, (performance.now() - this.modeAt) / 1000, this.level), this.box.width / ICON_CELLS);
      },
    };
  }
}
