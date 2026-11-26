import { describe, expect, it } from "vitest";
import { DEVICE_LEVELS, DISPLAY_CURVE, SIMULATOR_ALPHA, SIMULATOR_LEVELS, calibrate } from "../src/core/calibrate";
import { LENS, lensTiles } from "../src/core/board";

describe("display calibration", () => {
  it("the table never goes down, keeps 0 at 0 and never turns a lit level dark", () => {
    expect(SIMULATOR_LEVELS).toHaveLength(16);
    expect(SIMULATOR_LEVELS[0]).toBe(0);
    for (let l = 1; l < 16; l++) {
      expect(SIMULATOR_LEVELS[l]).toBeGreaterThanOrEqual(SIMULATOR_LEVELS[l - 1] as number);
      expect(SIMULATOR_LEVELS[l]).toBeGreaterThan(0);
    }
    expect(SIMULATOR_LEVELS[15]).toBe(15);
  });

  it("each logical level gets the device level whose shown alpha is nearest to level / 15", () => {
    for (let l = 1; l < 15; l++) {
      const want = (l / 15) * 255;
      const best = Math.min(...Array.from({ length: 9 }, (_, d) => d).filter((d) => d > 0).map((d) => Math.abs((SIMULATOR_ALPHA[d] as number) - want)));
      expect(Math.abs((SIMULATOR_ALPHA[SIMULATOR_LEVELS[l] as number] as number) - want)).toBeCloseTo(best, 6);
    }
  });

  it("the shown brightness never falls, so dim stays dimmer than lit", () => {
    for (let l = 1; l < 16; l++) expect(SIMULATOR_ALPHA[SIMULATOR_LEVELS[l] as number] as number).toBeGreaterThanOrEqual(SIMULATOR_ALPHA[SIMULATOR_LEVELS[l - 1] as number] as number);
  });

  it("calibrate maps a byte through the table and leaves the input alone", () => {
    const input = Uint8Array.from({ length: 16 }, (_, l) => l * 17);
    const copy = input.slice();
    const out = calibrate(input);
    expect(input).toEqual(copy);
    expect([...out]).toEqual(DEVICE_LEVELS.map((d) => d * 17));
    expect(DISPLAY_CURVE).toBe("simulator");
  });

  it("the tiles sent equal calibrate(render)", () => {
    const frame = Uint8Array.from({ length: LENS.width * LENS.height }, (_, i) => (i % 16) * 17);
    const tiles = lensTiles(() => frame, () => 1);
    const want = calibrate(frame);
    for (const tile of tiles) {
      const got = tile.render(0);
      const { x, y, width, height } = tile.box;
      for (let row = 0; row < height; row++) expect(got.subarray(row * width, (row + 1) * width)).toEqual(want.subarray((y + row) * LENS.width + x, (y + row) * LENS.width + x + width));
    }
  });
});
