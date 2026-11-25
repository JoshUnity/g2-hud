import type { Box } from "./box";
import { drawIcon, type IconGrid } from "./icon";
import { Canvas, lv } from "./pixels";
import { calibrate } from "./calibrate";
import { tiled } from "./tiles";
import type { Producer } from "./imagepipe";

/**
 * The board's shared parts, drawn pixel for pixel like the board's engine (`test/board/hud.cjs`). The lens is
 * one 576 x 288 raster in four 288 x 144 image tiles, with the glasses font in text containers on top.
 * See DESIGN.md, "The board is the reference".
 */

export const LENS = { width: 576, height: 288 } as const;

/** The four image tiles of the lens, ids 1 to 4: top left, top right, bottom left, bottom right. */
export const LENS_TILES: Box[] = [
  { id: 1, name: "t00", x: 0, y: 0, width: 288, height: 144 },
  { id: 2, name: "t10", x: 288, y: 0, width: 288, height: 144 },
  { id: 3, name: "t01", x: 0, y: 144, width: 288, height: 144 },
  { id: 4, name: "t11", x: 288, y: 144, width: 288, height: 144 },
];

/** A full-lens canvas that draws like the board: the last write wins (`over`), black included. */
export function lensCanvas(): Canvas {
  return new Canvas(LENS.width, LENS.height, true);
}

/**
 * The four lens tiles as image producers, slicing one full-lens render per tick. This is where the display
 * calibration is applied (see calibrate.ts): renderers draw the board's logical levels, the tiles hold what is sent.
 */
export function lensTiles(render: (t: number) => Uint8Array, fps: () => number): Producer[] {
  return tiled(LENS_TILES, LENS, (t) => calibrate(render(t)), fps);
}

/** The status label of the header is glasses text: this is where it goes (add the header's `ox` to x). */
export const STATUS_AT = { x: 32, y: 0, level: 3 } as const;

/**
 * The board's `hdr` without its text: the app icon at (ox, 2) with 2 px cells, the clock in scale 2 pixel
 * digits ending at x 576, y 7, and a hairline at y 30 from ox to the right edge.
 */
export function drawHeader(canvas: Canvas, icon: IconGrid, clock: string, ox = 0): void {
  drawIcon(canvas, icon, ox, 2, 2, 0, 255, lv(0.4));
  canvas.textRight(LENS.width, 7, clock, lv(0.8), 2);
  canvas.rect(ox, 30, LENS.width - ox, 1, lv(0.3));
}

/** The board's five meter bar heights at time `t`, each 0 to 1 (an input level, or the board's idle motion). */
export function meterLevels(t: number): number[] {
  return Array.from({ length: 5 }, (_, i) => Math.abs(Math.sin(t * 3.1 + i * 1.7) * Math.sin(t * 0.9 + i)));
}

/** The board's `meter`: five 3 px bars on a pitch of 5, standing on y 22, each 3 to 13 px high for a level of 0 to 1. */
export function drawMeter(canvas: Canvas, x: number, levels: readonly number[]): void {
  for (let i = 0; i < 5; i++) {
    const h = 3 + Math.round(10 * (levels[i] ?? 0));
    canvas.p(x + i * 5, 22 - h, lv(0.85), 3, h);
  }
}

/** The board's `pages`: `count` 6 x 6 squares on a pitch of 10 at y 10; the current one filled, the others outlined. */
export function drawPages(canvas: Canvas, x: number, count: number, current: number): void {
  for (let i = 0; i < count; i++) {
    if (i === current) canvas.p(x + i * 10, 10, 255, 6, 6);
    else canvas.box(x + i * 10, 10, 6, 6, lv(0.55));
  }
}

export type TabState = "active" | "idle" | "waiting";

/**
 * The board's `tabs`, for any number of tabs: 8 x 8 squares on a pitch of 12 at y 9. Active is filled, idle an
 * outline. The board has no waiting tab: it is an outline at full light with a 2 x 2 core (a tab that needs you).
 */
export function drawTabs(canvas: Canvas, x: number, tabs: readonly TabState[]): void {
  tabs.forEach((state, i) => {
    const left = x + i * 12;
    if (state === "active") canvas.p(left, 9, 255, 8, 8);
    else if (state === "idle") canvas.box(left, 9, 8, 8, lv(0.55));
    else {
      canvas.box(left, 9, 8, 8, 255);
      canvas.p(left + 3, 12, 255, 2, 2);
    }
  });
}
