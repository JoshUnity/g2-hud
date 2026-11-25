import type { Box } from "./box";
import type { Producer } from "./imagepipe";

/**
 * Splits one large raster into image containers (each at most 288 x 144). The
 * full frame is rendered once per tick and sliced; the pipe only sends tiles
 * whose pixels changed, so a pulse in one corner costs one tile.
 */
export function tiled(
  tiles: Box[],
  full: { width: number; height: number },
  render: (t: number) => Uint8Array,
  fps: () => number,
): Producer[] {
  let cache: { tick: number; frame: Uint8Array } | null = null;
  const frameAt = (t: number): Uint8Array => {
    const rate = Math.max(fps(), 0.5);
    const tick = Math.floor(t * rate);
    if (!cache || cache.tick !== tick) cache = { tick, frame: render(t) };
    return cache.frame;
  };
  return tiles.map((box) => ({
    box,
    fps,
    invalidate: () => {
      cache = null;
    },
    render: (t) => {
      const frame = frameAt(t);
      const out = new Uint8Array(box.width * box.height);
      for (let y = 0; y < box.height; y++) {
        const from = (box.y + y) * full.width + box.x;
        out.set(frame.subarray(from, from + box.width), y * box.width);
      }
      return out;
    },
  }));
}
