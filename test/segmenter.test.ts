import { describe, expect, it } from "vitest";
import { BYTES_PER_MS, Segmenter, type Segment } from "../server/segmenter";

/** 100 ms of a steady tone with the given RMS level (0 = digital silence). */
function frame(level: number): Buffer {
  const samples = (BYTES_PER_MS * 100) / 2;
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = level * Math.SQRT2;
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i / 5)), i * 2);
  return pcm;
}

function feed(segmenter: Segmenter, level: number, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) segmenter.push(frame(level), "other");
}

describe("Segmenter noise floor", () => {
  it("learns steady background that starts loud after a quiet start (one long segment, then none)", () => {
    const out: Segment[] = [];
    const segmenter = new Segmenter((s) => out.push(s));
    feed(segmenter, 50, 5); // quiet room
    feed(segmenter, 600, 300); // then a cafe: five minutes of steady noise, nobody speaks
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it("still cuts sentences at pauses once the background is learned", () => {
    const out: Segment[] = [];
    const segmenter = new Segmenter((s) => out.push(s));
    feed(segmenter, 50, 5);
    feed(segmenter, 600, 20);
    const before = out.length;
    for (let i = 0; i < 6; i++) {
      feed(segmenter, 3000, 2); // a 2 s sentence
      feed(segmenter, 600, 2); // a 2 s pause in the noise
    }
    expect(out.length - before).toBe(6);
  });

  it("does not drop the floor to zero for one silent frame in learned background", () => {
    const out: Segment[] = [];
    const segmenter = new Segmenter((s) => out.push(s));
    feed(segmenter, 600, 60);
    expect(out).toHaveLength(0);
    segmenter.push(frame(0), "other");
    feed(segmenter, 600, 300);
    expect(out).toHaveLength(0);
  });

  it("hears quiet speech in a quiet room", () => {
    const out: Segment[] = [];
    const segmenter = new Segmenter((s) => out.push(s));
    feed(segmenter, 50, 3);
    feed(segmenter, 700, 2);
    feed(segmenter, 50, 1);
    expect(out).toHaveLength(1);
  });
});
