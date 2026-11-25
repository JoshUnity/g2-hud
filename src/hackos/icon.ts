import type { IconGrid, IconOrder } from "../core/icon";

/** Two posts with a pair of eyes between them. */
export const ICON: IconGrid = [
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##.##..##.##",
  "##.##..##.##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
  "##........##",
];

/** The two posts rise from the base; the eyes light across the middle. */
export const ORDER: IconOrder = (row, col) =>
  (row === 5 || row === 6) && col > 1 && col < 10 ? 0.6 + ((col - 2) / 8) * 0.35 : ((11 - row) / 11) * 0.55;
