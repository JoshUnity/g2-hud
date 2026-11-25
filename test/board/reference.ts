import { createRequire } from "node:module";
import { textWidth } from "../../src/core/text";

/**
 * The approved board as a test reference. `hud.cjs` is the board's own drawing engine, copied verbatim. This file
 * gives it a software canvas: every pixel the engine fills lands in a 576 x 288 grid of grey levels, and every
 * line of glasses-font text it draws is recorded as data (the board's font is not the glasses font, so text is
 * never rasterised).
 */

export type BoardApp = "answers" | "code" | "hackos" | "around" | "sky";
export type BoardText = { text: string; x: number; y: number; level: number; align: "left" | "right" | "center" };

export const BOARD_W = 576;
export const BOARD_H = 288;

type Engine = { draw: (ctx: unknown, app: string, screen: string, t: number) => void };
const engine = createRequire(import.meta.url)("./hud.cjs") as Engine;

/** The engine's opening: how long it runs (ms) and the screen it settles on. The logo runs 1600 ms before it. */
export const BOARD_OPEN: Record<BoardApp, { ms: number; screen: string }> = {
  answers: { ms: 3000, screen: "listening" },
  code: { ms: 2400, screen: "working" },
  hackos: { ms: 2000, screen: "answer" },
  around: { ms: 2600, screen: "live" },
  sky: { ms: 3000, screen: "live" },
};
/** The logo's length in ms. */
export const BOARD_LOGO_MS = 1600;

/** The engine's own screen names, by app. */
export const BOARD_SCREENS: Record<BoardApp, string[]> = {
  answers: ["listening", "recall", "answer"],
  code: ["working", "allow"],
  hackos: ["waking", "answer"],
  around: ["live"],
  sky: ["live"],
};

/** The time `t` (seconds, for `screen: "intro"`) that is `ms` into the logo, 0 to 1600. Avoid 900, 1250 and 1300 exactly. */
export function boardIntroT(ms: number): number {
  return ms / 1000;
}

/** The time `t` (seconds, for `screen: "intro"`) at which the opening of `app` is at clock progress `r`, 0 to 1. */
export function boardOpeningT(app: BoardApp, r: number): number {
  return (BOARD_LOGO_MS + r * BOARD_OPEN[app].ms) / 1000;
}

/** The reveal the engine uses at opening progress `r`: `r` itself, eased (smoothstep) for Around. */
export function boardReveal(app: BoardApp, r: number): number {
  return app === "around" ? r * r * (3 - 2 * r) : r;
}

/** The engine's text brightness: its alphas turned into levels (LV = [0, .36, .56, .78, 1] -> 0, 5, 8, 12, 15). */
const TEXT_LEVEL: Record<number, number> = { 0: 0, 5: 1, 8: 2, 12: 3, 15: 4 };

/** The engine's grey table is rgb(60k, 250k, 68k) for k = level / 15; anything else (`#000`) is black. */
function levelOf(style: string): number {
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(style);
  return m ? Math.round((Number(m[2]) / 250) * 15) : 0;
}

/** Draws the board frame for `app` and `screen` at time `t` (seconds). Screen `intro` is the logo, the opening, then the live screen. */
export function boardFrame(app: BoardApp, screen: string, t: number): { pixels: Uint8Array; texts: BoardText[] } {
  const pixels = new Uint8Array(BOARD_W * BOARD_H);
  const texts: BoardText[] = [];
  const ctx = {
    fillStyle: "#000",
    font: "",
    textAlign: "left",
    textBaseline: "top",
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number): void {
      const level = levelOf(this.fillStyle);
      for (let row = Math.max(0, y); row < Math.min(BOARD_H, y + h); row++)
        for (let col = Math.max(0, x); col < Math.min(BOARD_W, x + w); col++) pixels[row * BOARD_W + col] = level;
    },
    measureText(s: string): { width: number } {
      return { width: textWidth(s) };
    },
    fillText(s: string, x: number, y: number): void {
      const level = TEXT_LEVEL[levelOf(this.fillStyle)];
      if (level === undefined) throw new Error(`The board drew text in an unknown light: ${this.fillStyle}`);
      texts.push({ text: s, x, y: y - 4, level, align: this.textAlign as BoardText["align"] });
    },
  };
  engine.draw(ctx, app, screen, t);
  return { pixels, texts };
}
