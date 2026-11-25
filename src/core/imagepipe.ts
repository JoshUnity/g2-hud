import { ImageRawDataUpdate, ImageRawDataUpdateResult, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Box } from "./box";
import { sameFrame } from "./pixels";

/** A send that has not settled after this long counts as failed. */
export const SEND_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Producer = {
  box: Box;
  /** Frames per second wanted right now; 0 means "only when the picture changes". */
  fps: () => number;
  render: (t: number) => Uint8Array;
  /** Drops any cached frame, so the next render uses the current data. */
  invalidate?: () => void;
};

type Slot = Producer & { last: Uint8Array | null; due: number };

/**
 * The one path to the image containers. The SDK allows no concurrent image sends
 * and holds the path ~100 ms per send, so producers take turns: whichever is due
 * first renders, and the frame is sent only if it changed.
 */
export class ImagePipe {
  private slots: Slot[] = [];
  private running = false;
  /** Bumped by stop(); a loop ends as soon as it sees a newer generation than its own. */
  private generation = 0;
  /** The current loop; a new run() waits for it, so two loops never send at once. */
  private loop: Promise<void> = Promise.resolve();
  private readonly started = performance.now();
  /** Sends that have not settled yet (a send past the timeout may still be in flight). */
  private inFlight = 0;
  private idle: (() => void)[] = [];

  constructor(private bridge: EvenAppBridge) {}

  /** Replaces the producers (after a page rebuild, the old containers are gone). */
  set(producers: Producer[]): void {
    const now = performance.now();
    this.slots = producers.map((p) => ({ ...p, last: null, due: now }));
  }

  /** Forces a re-render soon, for example when new data arrives. */
  poke(name?: string): void {
    const now = performance.now();
    for (const slot of this.slots) {
      if (name && slot.box.name !== name) continue;
      slot.invalidate?.();
      slot.due = Math.min(slot.due, now);
    }
  }

  /** Resolves when no image send is in flight: wait for it before a page rebuild, so the two never overlap. */
  settled(): Promise<void> {
    return this.inFlight === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.push(resolve));
  }

  /**
   * One send. A rejection or a send that outlasts SEND_TIMEOUT_MS counts as failed. Trade-off: after a timeout
   * the hung send may still be in flight when the next one starts, so the "one send at a time" rule is broken
   * once, on purpose: a host that never answers must not freeze the pictures for good. `settled()` still waits
   * for the hung send to end.
   */
  private async send(box: Box, frame: Uint8Array): Promise<boolean> {
    this.inFlight++;
    const call = Promise.resolve()
      .then(() => this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: box.id, containerName: box.name, imageData: frame })))
      .finally(() => {
        if (--this.inFlight === 0) for (const wake of this.idle.splice(0)) wake();
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SEND_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([call, late])) === ImageRawDataUpdateResult.success;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the loop; a send in flight still completes. */
  stop(): void {
    this.running = false;
    this.generation++;
  }

  /** Starts the loop. After a stop(), the new loop starts only once the old one has ended. */
  run(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    const generation = ++this.generation;
    // A failed old loop has already rejected its own run(); it must not block this one.
    this.loop = this.loop.catch(() => undefined).then(() => this.spin(generation));
    return this.loop;
  }

  private async spin(generation: number): Promise<void> {
    let failures = 0;
    while (generation === this.generation) {
      const now = performance.now();
      const slot = [...this.slots].sort((a, b) => a.due - b.due)[0];
      if (!slot || slot.due > now) {
        await sleep(slot ? Math.min(250, Math.max(20, slot.due - now)) : 250);
        continue;
      }
      let frame: Uint8Array;
      try {
        const fps = slot.fps();
        slot.due = now + (fps > 0 ? 1000 / fps : 2000);
        frame = slot.render((now - this.started) / 1000);
      } catch {
        // A producer that throws counts as a failed send: the others keep going.
        if (++failures > 5) await sleep(2000);
        continue;
      }
      if (slot.last && sameFrame(frame, slot.last)) continue;
      if (await this.send(slot.box, frame)) {
        slot.last = frame;
        failures = 0;
      } else if (++failures > 5) {
        await sleep(2000); // the link is struggling; back off
      }
    }
  }
}
