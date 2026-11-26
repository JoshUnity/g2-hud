import { ICON } from "./icon";
import type { IconGrid } from "../core/icon";

/**
 * The header icon of Code (24 x 24, from ICON) by state. The chevron stays; the cursor block (rows 3 to 8,
 * columns 7 to 10) carries the state.
 *
 * - idle: still.
 * - recording: the block is a low bar that rises with the voice level.
 * - busy (transcribing, working): a one-column bar slides to and fro across the block, the rest of it dim.
 * - approval: the block is hollow and blinks dim twice a second.
 * - dim: everything dim (error, off, no connection).
 */
export type IconState = "idle" | "recording" | "busy" | "approval" | "dim";

const BLOCK_ROWS = [3, 4, 5, 6, 7, 8] as const;
const BLOCK_COLS = [7, 8, 9, 10] as const;

function edit(change: (cells: string[][]) => void): IconGrid {
  const cells = ICON.map((row) => row.split(""));
  change(cells);
  return cells.map((row) => row.join(""));
}

const set = (cells: string[][], row: number, col: number, char: string): void => {
  const line = cells[row];
  if (line) line[col] = char;
};

/** The grid for a state at time `t` (seconds) and voice level (0 to 1). */
export function iconFrame(state: IconState, t: number, level = 0): IconGrid {
  switch (state) {
    case "idle":
      return ICON;
    case "recording": {
      const height = 1 + Math.round(Math.max(0, Math.min(1, level)) * (BLOCK_ROWS.length - 1));
      return edit((cells) => {
        for (const row of BLOCK_ROWS) for (const col of BLOCK_COLS) set(cells, row, col, row > BLOCK_ROWS.length + 2 - height ? "#" : ".");
      });
    }
    case "busy": {
      const k = Math.floor(t * 6) % 6;
      const bar = BLOCK_COLS[0] + (k < 4 ? k : 6 - k);
      return edit((cells) => {
        for (const row of BLOCK_ROWS) for (const col of BLOCK_COLS) set(cells, row, col, col === bar ? "#" : "+");
      });
    }
    case "approval": {
      const dim = Math.floor(t * 2) % 2 === 1;
      return edit((cells) => {
        // The hollow: the middle of the block is off, the rim is the block's edge.
        for (const row of [4, 5, 6, 7]) for (const col of [8, 9]) set(cells, row, col, ".");
        if (dim) for (const row of BLOCK_ROWS) for (const col of BLOCK_COLS) if (cells[row]?.[col] === "#") set(cells, row, col, "+");
      });
    }
    case "dim":
      return ICON.map((row) => row.replace(/#/g, "+"));
  }
}

/** Frames a second wanted for a state: 0 for a still icon. */
export function iconFps(state: IconState): number {
  switch (state) {
    case "recording":
      return 8;
    case "busy":
      return 6;
    case "approval":
      return 4;
    default:
      return 0;
  }
}
