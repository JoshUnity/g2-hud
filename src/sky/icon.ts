import type { IconGrid, IconOrder } from "../core/icon";

/** An aircraft seen from above. */
export const ICON: IconGrid = [
  ".....##.....",
  ".....##.....",
  ".....##.....",
  "....####....",
  "..########..",
  "############",
  "###..##..###",
  ".....##.....",
  ".....##.....",
  "....####....",
  "..########..",
  ".....##.....",
];

/** The mark builds from the tail up to the nose. */
export const ORDER: IconOrder = (row) => ((11 - row) / 11) * 0.9;
