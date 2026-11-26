import { describe, expect, it } from "vitest";
import { Canvas } from "../src/core/pixels";

/** The old unclipped Bresenham walk, as the reference. */
function reference(c: Canvas, x0: number, y0: number, x1: number, y1: number, value: number, pattern?: [number, number]): void {
  let x = Math.round(x0), y = Math.round(y0);
  const ex = Math.round(x1), ey = Math.round(y1);
  const dx = Math.abs(ex - x), dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; ; i++) {
    if (!pattern || i % (pattern[0] + pattern[1]) < pattern[0]) c.plot(x, y, value);
    if (x === ex && y === ey) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

describe("line walk", () => {
  it("draws exactly what the full Bresenham walk draws, solid and dashed, for lines that cross the canvas", () => {
    let seed = 7;
    const rnd = (n: number): number => ((seed = (seed * 48271) % 2147483647) / 2147483647) * n - n / 4;
    for (let i = 0; i < 400; i++) {
      const [a, b, c, d] = [rnd(400), rnd(400), rnd(400), rnd(400)];
      const want = new Canvas(60, 40);
      const got = new Canvas(60, 40);
      reference(want, a, b, c, d, 200);
      got.line(a, b, c, d, 200);
      expect([...got.pixels], `line ${a} ${b} ${c} ${d}`).toEqual([...want.pixels]);
      const dashWant = new Canvas(60, 40);
      const dashGot = new Canvas(60, 40);
      reference(dashWant, a, b, c, d, 200, [3, 2]);
      dashGot.dashed(a, b, c, d, 200, 3, 2);
      expect([...dashGot.pixels], `dashed ${a} ${b} ${c} ${d}`).toEqual([...dashWant.pixels]);
    }
  });
  it("returns the phase of the full line, so a polyline keeps its pattern", () => {
    const c = new Canvas(20, 1);
    expect(c.dashed(-1000, 0, 1000, 0, 100, 3, 2)).toBe(c.dashed(0, 0, 2000, 0, 100, 3, 2));
  });
  it("draws an end point a million pixels away as the clipped line, and quickly", () => {
    const far = new Canvas(100, 100);
    const t = performance.now();
    far.line(10, 10, 1_000_010, 1_000_010, 255);
    far.dashed(0, 50, 1_000_000, 50, 255, 2, 2);
    expect(performance.now() - t).toBeLessThan(200);
    const near = new Canvas(100, 100);
    near.line(10, 10, 120, 120, 255);
    near.dashed(0, 50, 200, 50, 255, 2, 2);
    expect([...far.pixels]).toEqual([...near.pixels]);
    const none = new Canvas(10, 10);
    none.line(-1_000_000, -5, -999_000, 500, 255);
    expect(none.pixels.every((v) => v === 0)).toBe(true);
  });
});
