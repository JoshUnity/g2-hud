import type { IconGrid, IconOrder } from "../core/icon";

/** A ring around a bright core: the Answers icon at rest. */
export const ICON: IconGrid = [
  "....####....",
  "..##....##..",
  ".#........#.",
  ".#...##...#.",
  "#...####...#",
  "#..######..#",
  "#..######..#",
  "#...####...#",
  ".#...##...#.",
  ".#........#.",
  "..##....##..",
  "....####....",
];

const core = (row: number, col: number): boolean => row >= 3 && row <= 8 && col >= 3 && col <= 8;
const dist = (row: number, col: number): number => Math.hypot(row - 5.5, col - 5.5) / 7.8;

/** The core lights last, after the ring has drawn itself clockwise from the top. */
export const ORDER: IconOrder = (row, col) => {
  if (core(row, col)) return 0.76 + dist(row, col) * 0.3;
  let g = Math.atan2(col - 5.5, 5.5 - row);
  if (g < 0) g += Math.PI * 2;
  return (g / (Math.PI * 2)) * 0.7;
};
