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
