import type { IconGrid, IconOrder } from "../core/icon";

/** A ring with crosshair ticks and a centre dot. */
export const ICON: IconGrid = [
  ".....##.....",
  ".....##.....",
  "...######...",
  "..##....##..",
  "..#......#..",
  "###..##..###",
  "###..##..###",
  "..#......#..",
  "..##....##..",
  "...######...",
  ".....##.....",
  ".....##.....",
];

/** The mark grows outward from the centre. */
export const ORDER: IconOrder = (row, col) => (Math.hypot(row - 5.5, col - 5.5) / 7.8) * 0.95;
