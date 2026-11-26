import { ImageRawDataUpdateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePipe, SEND_TIMEOUT_MS } from "../src/core/imagepipe";

const box = { id: 1, name: "t", x: 0, y: 0, width: 1, height: 1 };
const pipeOf = (send: () => Promise<ImageRawDataUpdateResult>) => new ImagePipe({ updateImageRawData: send } as unknown as EvenAppBridge);

afterEach(() => vi.useRealTimers());

describe("ImagePipe failures", () => {
  it("goes on after a rejected send, and after a producer that throws", async () => {
    let calls = 0;
    const pipe = pipeOf(async () => {
      if (++calls === 1) throw new Error("the host fell over");
      return ImageRawDataUpdateResult.success;
    });
    let n = 0;
    pipe.set([{ box, fps: () => 50, render: () => { if (n === 1) { n++; throw new Error("bad frame"); } return new Uint8Array([++n]); } }]);
    const loop = pipe.run();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    pipe.stop();
    await expect(loop).resolves.toBeUndefined();
  });

  it("counts a send that has not settled after 5 s as failed, and sends the next one", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pipe = pipeOf(() => (++calls === 1 ? new Promise(() => undefined) : Promise.resolve(ImageRawDataUpdateResult.success)));
    let n = 0;
    pipe.set([{ box, fps: () => 5, render: () => new Uint8Array([++n]) }]);
    void pipe.run();
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 100);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBeGreaterThanOrEqual(2);
    pipe.stop();
  });
});

describe("ImagePipe.settled", () => {
  it("resolves at once when idle, and when the send in flight ends", async () => {
    await expect(pipeOf(async () => ImageRawDataUpdateResult.success).settled()).resolves.toBeUndefined();
    let finish: (r: ImageRawDataUpdateResult) => void = () => {};
    const send = vi.fn(() => new Promise<ImageRawDataUpdateResult>((resolve) => (finish = resolve)));
    const pipe = pipeOf(send);
    pipe.set([{ box, fps: () => 0, render: () => new Uint8Array([1]) }]);
    const loop = pipe.run();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    let done = false;
    void pipe.settled().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    pipe.stop();
    finish(ImageRawDataUpdateResult.success);
    await loop;
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it("also waits for a send that timed out and is still hanging", async () => {
    vi.useFakeTimers();
    const finishers: ((r: ImageRawDataUpdateResult) => void)[] = [];
    const pipe = pipeOf(() => new Promise((resolve) => finishers.push(resolve)));
    pipe.set([{ box, fps: () => 0, render: () => new Uint8Array([1]) }]);
    void pipe.run();
    await vi.advanceTimersByTimeAsync(10);
    let done = false;
    void pipe.settled().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 100);
    pipe.stop();
    expect(done).toBe(false);
    for (const finish of finishers) finish(ImageRawDataUpdateResult.success);
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
  });
});
