import type { Box } from "../core/box";
import { LINE } from "../core/text";

/**
 * The one page of Code: the lens is four image tiles (ids 1 to 4, `LENS_TILES` in src/core/board.ts) and the
 * glasses font sits in these eight text containers on top, each at the place the board's `tx` calls put it
 * (test/board/hud.cjs). Every state uses the same page; a container with nothing to show holds "".
 */

/** The status, at the board's (32, 0). The clock and the tab squares are in the raster. */
export const STATUS: Box = { id: 5, name: "status", x: 32, y: 0, width: 544, height: LINE };
/**
 * The instruction, at (0, 36) over two lines. It is wrapped at PROMPT_WRAP px: the width at which the board's
 * "Add a dark mode toggle to the settings page" breaks after "the", as on the board.
 */
export const PROMPT_WRAP = 330;
export const PROMPT: Box = { id: 6, name: "prompt", x: 0, y: 36, width: 336, height: 2 * LINE };
/** Results and messages, from (0, 72) in the board's 27 px rows. Takes the input. */
export const BODY: Box = { id: 7, name: "body", x: 0, y: 72, width: 576, height: 8 * LINE };
export const BODY_LINES = 8;

export const STEP_ROWS = 4;
/** Earlier steps (brightness 2) and the current step (brightness 4, on its own row) from (18, 100). */
export const STEPS: Box = { id: 8, name: "steps", x: 18, y: 100, width: 270, height: STEP_ROWS * LINE };
export const STEP: Box = { id: 9, name: "step", x: 18, y: 100, width: 270, height: STEP_ROWS * LINE };

/** The approval card is in the raster: the call at (20, 96) brightness 4, the folder line at (20, 123) brightness 2. */
export const CALL_WIDTH = 536;
export const CALL_LINES = 2;
export const CALL: Box = { id: 10, name: "call", x: 20, y: 96, width: CALL_WIDTH, height: CALL_LINES * LINE };
export const FOLDER: Box = { id: 11, name: "folder", x: 20, y: 123, width: CALL_WIDTH, height: LINE };
/** The hint, at the board's (0, 255). */
export const HINT: Box = { id: 12, name: "hint", x: 0, y: 255, width: 576, height: LINE };

/** The text containers in order; one page for every state. */
export const TEXT_BOXES: Box[] = [STATUS, PROMPT, STEPS, STEP, CALL, FOLDER, HINT, BODY];
