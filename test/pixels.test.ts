import { GLYPHS } from "../src/core/font5x7";
import { ImageRawDataUpdateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { describe, expect, it, vi } from "vitest";
import { ImagePipe } from "../src/core/imagepipe";
import { Canvas } from "../src/core/pixels";
import { tiled } from "../src/core/tiles";

const row = (c: Canvas) => [...c.pixels].map((v) => (v > 0 ? 1 : 0)).join("");

/** A straight run from 0 to `to` along y = 0, with a vertex every `step` px. */
function run(to: number, step: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i * step < to; i++) points.push([i * step, 0]);
  points.push([to, 0]);
  return points;
}

describe("stipple", () => {
  it("leaves real gaps in a 1-on 1-off line", () => {
    const c = new Canvas(20, 1);
    c.polyline([[0, 0], [19, 0]], 200, [1, 1]);
    const lit = [...c.pixels].map((v) => (v > 0 ? 1 : 0)).join("");
    expect(lit).toBe("10101010101010101010");
  });
  it("draws 3-on 2-off dashes", () => {
    const c = new Canvas(10, 1);
    c.polyline([[0, 0], [9, 0]], 200, [3, 2]);
    expect([...c.pixels].map((v) => (v > 0 ? 1 : 0)).join("")).toBe("1110011100");
  });
  it("keeps the pattern across short polyline segments", () => {
    for (const pattern of [[1, 3], [1, 1], [3, 2]] as [number, number][]) {
      const one = new Canvas(40, 1);
      one.polyline([[0, 0], [39, 0]], 200, pattern);
      for (const step of [1, 2, 3, 0.5]) {
        const many = new Canvas(40, 1);
        many.polyline(run(39, step), 200, pattern);
        expect(row(many), `pattern ${pattern} step ${step}`).toBe(row(one));
      }
    }
  });
  it("does not drop a road made of segments shorter than half a pixel", () => {
    const c = new Canvas(40, 1);
    c.polyline(run(39, 0.4), 200, [1, 3]);
    const lit = row(c).split("").filter((v) => v === "1").length;
    expect(lit).toBe(10);
  });
});

describe("tiled frame cache", () => {
  it("renders the new data after invalidate, within the same tick", () => {
    let value = 1;
    const box = { id: 1, name: "t", x: 0, y: 0, width: 2, height: 1 };
    const [tile] = tiled([box], { width: 2, height: 1 }, () => new Uint8Array([value, value]), () => 0);
    expect([...tile!.render(0.1)]).toEqual([1, 1]);
    value = 2;
    expect([...tile!.render(0.2)]).toEqual([1, 1]); // same tick: cached
    tile!.invalidate?.();
    expect([...tile!.render(0.3)]).toEqual([2, 2]);
  });

  it("is invalidated by ImagePipe.poke", () => {
    const pipe = new ImagePipe({} as EvenAppBridge);
    const invalidate = vi.fn();
    const box = { id: 1, name: "t", x: 0, y: 0, width: 1, height: 1 };
    pipe.set([{ box, fps: () => 0, render: () => new Uint8Array(1), invalidate }]);
    pipe.poke();
    expect(invalidate).toHaveBeenCalledTimes(1);
    pipe.poke("other");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("ImagePipe.stop", () => {
  it("ends the run loop", async () => {
    const send = vi.fn(async () => ImageRawDataUpdateResult.success);
    const pipe = new ImagePipe({ updateImageRawData: send } as unknown as EvenAppBridge);
    const box = { id: 1, name: "t", x: 0, y: 0, width: 1, height: 1 };
    pipe.set([{ box, fps: () => 0, render: () => new Uint8Array(1) }]);
    const loop = pipe.run();
    pipe.stop();
    await expect(loop).resolves.toBeUndefined();
    expect(send.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("runs one loop after a stop and a quick restart, and never two sends at once", async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const send = vi.fn(() => {
      most = Math.max(most, ++inFlight);
      return new Promise<ImageRawDataUpdateResult>((resolve) =>
        pending.push(() => {
          inFlight--;
          resolve(ImageRawDataUpdateResult.success);
        }),
      );
    });
    const pipe = new ImagePipe({ updateImageRawData: send } as unknown as EvenAppBridge);
    const box = { id: 1, name: "t", x: 0, y: 0, width: 1, height: 1 };
    let n = 0;
    pipe.set([{ box, fps: () => 0, render: () => new Uint8Array([++n]) }]);
    const first = pipe.run();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Stopped while the first send is in flight, then started again at once (a page rebuild).
    pipe.stop();
    const second = pipe.run();
    pipe.poke();
    await new Promise((r) => setTimeout(r, 60));
    expect(send).toHaveBeenCalledTimes(1); // the new loop waits for the old send
    pending.shift()?.();
    // The old loop ends after its send; it does not go on beside the new one.
    const ended = await Promise.race([first.then(() => "ended"), new Promise((r) => setTimeout(() => r("still running"), 500))]);
    expect(ended).toBe("ended");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    pipe.stop();
    pending.shift()?.();
    await expect(second).resolves.toBeUndefined();
    expect(most).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("blit", () => {
  it("copies a frame at an offset and keeps the brighter pixel", () => {
    const c = new Canvas(4, 3);
    c.plot(1, 1, 200);
    c.plot(2, 1, 50);
    c.blit(new Uint8Array([100, 100, 100, 100]), 2, 2, 1, 1);
    expect([...c.pixels]).toEqual([0, 0, 0, 0, 0, 200, 100, 0, 0, 100, 100, 0]);
  });

  it("clips at every edge", () => {
    const c = new Canvas(2, 2);
    c.blit(new Uint8Array(9).fill(9), 3, 3, -1, -1);
    expect([...c.pixels]).toEqual([9, 9, 9, 9]);
    c.blit(new Uint8Array(4).fill(200), 2, 2, 1, 1);
    expect([...c.pixels]).toEqual([9, 9, 9, 200]);
  });
});

describe("crisp canvas", () => {
  const values = (c: Canvas) => new Set(c.pixels);
  const lit = (c: Canvas) => [...c.pixels].filter((v) => v > 0).length;

  it("draws a Bresenham line at the flat value with no grey", () => {
    const c = new Canvas(20, 20);
    c.line(1.2, 1.4, 17.7, 9.1, 200);
    expect(values(c)).toEqual(new Set([0, 200]));
    // Endpoints are rounded to whole pixels: (1, 1) and (18, 9).
    expect(c.pixels[1 * 20 + 1]).toBe(200);
    expect(c.pixels[9 * 20 + 18]).toBe(200);
    // One pixel per column on a shallow line.
    expect(lit(c)).toBe(18 - 1 + 1);
  });

  it("draws a diagonal and a vertical line without gaps", () => {
    const c = new Canvas(10, 10);
    c.line(0, 0, 9, 9, 100);
    expect(lit(c)).toBe(10);
    const v = new Canvas(10, 10);
    v.line(3, 0, 3, 9, 100);
    expect(lit(v)).toBe(10);
  });

  it("draws a 1 px ring with only 0 and the value", () => {
    const c = new Canvas(21, 21);
    c.circle(10, 10, 8, 180);
    expect(values(c)).toEqual(new Set([0, 180]));
    for (const [x, y] of [[18, 10], [2, 10], [10, 2], [10, 18]] as const) expect(c.pixels[y * 21 + x]).toBe(180);
    expect(c.pixels[10 * 21 + 10]).toBe(0);
  });

  it("draws a filled disc with only 0 and the value", () => {
    const c = new Canvas(21, 21);
    c.disc(10, 10, 6, 220);
    expect(values(c)).toEqual(new Set([0, 220]));
    expect(c.pixels[10 * 21 + 10]).toBe(220);
    expect(c.pixels[10 * 21 + 16]).toBe(220);
    expect(c.pixels[10 * 21 + 17]).toBe(0);
    // A disc of radius 6 is 13 pixels wide: its area is close to pi * 6.5 squared.
    expect(Math.abs(lit(c) - Math.PI * 6.5 ** 2)).toBeLessThan(6);
  });

  it("keeps a disc inside the ring of the same radius", () => {
    const ring = new Canvas(21, 21);
    ring.circle(10, 10, 7, 255);
    const disc = new Canvas(21, 21);
    disc.disc(10, 10, 7, 255);
    ring.pixels.forEach((v, i) => {
      if (v > 0) expect(disc.pixels[i]).toBe(255);
    });
  });

  it("counts a dashed pattern in whole pixels along the line", () => {
    const c = new Canvas(12, 1);
    c.dashed(0, 0, 11, 0, 200, 3, 2);
    expect([...c.pixels].map((v) => (v > 0 ? 1 : 0)).join("")).toBe("111001110011");
    const d = new Canvas(10, 10);
    d.dashed(0, 0, 9, 9, 200, 2, 1);
    expect(values(d)).toEqual(new Set([0, 200]));
    expect(lit(d)).toBe(7); // pixels 0..9 with 2 on, 1 off: on at 0,1,3,4,6,7,9
  });

  it("carries the pattern across polyline vertices", () => {
    const one = new Canvas(40, 1);
    one.polyline([[0, 0], [39, 0]], 200, [3, 2]);
    const many = new Canvas(40, 1);
    many.polyline([[0, 0], [7, 0], [8, 0], [20, 0], [39, 0]], 200, [3, 2]);
    expect([...many.pixels]).toEqual([...one.pixels]);
  });

  it("fills a rectangle of whole pixels", () => {
    const c = new Canvas(8, 8);
    c.rect(2, 3, 3, 2, 150);
    expect(lit(c)).toBe(6);
    expect(c.pixels[3 * 8 + 2]).toBe(150);
    expect(c.pixels[4 * 8 + 4]).toBe(150);
    expect(c.pixels[5 * 8 + 4]).toBe(0);
  });

  it("draws a slanted line with only 0 and the value, never a soft grey", () => {
    const c = new Canvas(20, 20);
    c.line(0, 0, 19, 7, 200);
    expect(values(c)).toEqual(new Set([0, 200]));
  });
});

describe("type voices", () => {
  const lit = (c: Canvas, x: number, y: number) => (c.pixels[y * c.width + x] ?? 0) > 0;

  it("dots at scale 3 light 2 x 2 squares on a pitch of 3", () => {
    const c = new Canvas(20, 30);
    c.text(0, 0, "-", 200, 3, true); // "-" is one row of five pixels, at font row 3: y 9 to 11
    for (let col = 0; col < 5; col++) {
      for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 3; dy++) expect(lit(c, col * 3 + dx, 9 + dy), `${col} ${dx} ${dy}`).toBe(dx < 2 && dy < 2);
    }
  });

  it("lights exactly (scale - 1)^2 pixels per font pixel", () => {
    for (const scale of [3, 4, 6]) {
      const c = new Canvas(8 * scale, 8 * scale);
      c.text(0, 0, ".", 200, scale, true); // "." has 4 font pixels
      const count = [...c.pixels].filter((v) => v > 0).length;
      expect(count).toBe(4 * (scale - 1) ** 2);
      // gaps: the last column of each cell stays dark
      expect(lit(c, 5 * scale - 1, 5 * scale)).toBe(false);
    }
  });

  it("dots with scale 1 equal plain text, and the width is unchanged", () => {
    const a = new Canvas(40, 10);
    const b = new Canvas(40, 10);
    expect(a.text(1, 1, "AB1", 255, 1, true)).toBe(b.text(1, 1, "AB1", 255, 1, false));
    expect(a.pixels).toEqual(b.pixels);
    expect(new Canvas(60, 30).text(0, 0, "AB", 255, 3, true)).toBe(new Canvas(60, 30).text(0, 0, "AB", 255, 3));
  });

  it("textRight ends at xRight and textCenter is centred", () => {
    const c = new Canvas(100, 10);
    c.textRight(90, 0, "I", 255);
    const xs = [...c.pixels].flatMap((v, i) => (v > 0 ? [i % 100] : []));
    expect(Math.max(...xs)).toBeLessThanOrEqual(89);
    const w = Canvas.textWidth("12:34", 2);
    const r = new Canvas(100, 20);
    r.textRight(100, 0, "12:34", 255, 2);
    expect(r.pixels.some((v, i) => v > 0 && i % 100 === 99)).toBe(true); // "4" reaches the last column
    expect(w).toBe(5 * 6 * 2 - 2);
    const m = new Canvas(101, 10);
    m.textCenter(50, 0, "H", 255); // H is full width: columns 0 and 4 lit
    expect([...m.pixels].flatMap((v, i) => (v > 0 && i < 101 ? [i] : []))).toContain(48);
  });

  it("label clears a box 2 px around itself and then draws", () => {
    const c = new Canvas(40, 20);
    c.rect(0, 0, 40, 20, 120);
    c.label(10, 8, "AB", 255);
    expect(lit(c, 8, 6)).toBe(false); // top-left corner of the cleared box
    expect(lit(c, 7, 6)).toBe(true); // just outside it
    expect(lit(c, 10 + Canvas.textWidth("AB") + 1, 8 + 7 + 1)).toBe(false); // bottom-right inside the box
    expect(lit(c, 10 + Canvas.textWidth("AB") + 2, 8 + 7 + 2)).toBe(true); // outside
    expect(c.pixels[8 * 40 + 11]).toBe(255); // the A's apex
  });

  it("box draws a 1 px outline", () => {
    const c = new Canvas(10, 10);
    c.box(1, 2, 6, 5, 200);
    expect([...c.pixels].filter((v) => v > 0).length).toBe(2 * 6 + 2 * 3);
    expect(lit(c, 3, 4)).toBe(false);
  });

  it("has every glyph of the dot-matrix mock", () => {
    // From the mock's FONT table: 7 base-32 digits per glyph, bit 16 = left column.
    const mock: Record<string, string> = { ",": "0000c48", "·": "000cc00", "°": "ciic000", "!": "4444404", ">": "8421248" };
    for (const [char, rows] of Object.entries(mock)) {
      const bits = [...rows].map((d) => parseInt(d, 32).toString(2).padStart(5, "0"));
      expect(GLYPHS[char], char).toEqual(bits);
    }
  });
});
