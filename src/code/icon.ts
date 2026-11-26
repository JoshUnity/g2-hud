import type { IconGrid, IconOrder } from "../core/icon";

/** A prompt chevron and a cursor block. */
export const ICON: IconGrid = [
  "............",
  "##..........",
  ".##.........",
  "..##...####.",
  "...##..####.",
  "....##.####.",
  "....##.####.",
  "...##..####.",
  "..##...####.",
  ".##.........",
  "##..........",
  "............",
];

/** The chevron draws downward, then the cursor block fills in. */
export const ORDER: IconOrder = (row, col) => (col < 6 ? (row / 11) * 0.5 : 0.55 + (((col - 7) * 6 + (row - 3)) / 24) * 0.4);
