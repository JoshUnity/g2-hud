import { RIBBON_COLUMNS, RIBBON_HALF } from "./lens";

/**
 * The voice ribbon's column heights: how many 2 x 2 dots stand above and below the baseline in each of the 73
 * columns (0 to 5). `history` is the voice level per audio frame, newest first. The newest sample is at the centre
 * and older ones spread to both sides, two columns per sample, so the voice ripples outwards. A silent room is
 * the baseline only.
 */
export function ribbonColumns(history: readonly number[]): number[] {
  return Array.from({ length: RIBBON_COLUMNS }, (_, index) => {
    const k = index - RIBBON_HALF;
    const env = Math.cos((k / RIBBON_HALF) * (Math.PI / 2));
    const texture = 0.55 + 0.45 * Math.abs(Math.sin(k * 0.9 + 1));
    const i = Math.floor(Math.abs(k) / 2);
    const level = ((history[i] ?? 0) + (history[i + 1] ?? 0)) / 2;
    return Math.min(5, Math.round(level * texture * env * env * 6));
  });
}

/** The board's own motion for the same columns at time `t`, for the demo. */
export function boardColumns(t: number): number[] {
  return Array.from({ length: RIBBON_COLUMNS }, (_, index) => {
    const k = index - RIBBON_HALF;
    const env = Math.cos((k / RIBBON_HALF) * (Math.PI / 2));
    const v = Math.abs(Math.sin(k * 0.45 + t * 5) * Math.sin(k * 0.13 - t * 2.2)) * env * env;
    return Math.round(v * 5);
  });
}
