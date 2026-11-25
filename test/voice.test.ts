import { describe, expect, it } from "vitest";
import { voiceLevel } from "../src/core/voice";

const pcm = (...samples: number[]): Uint8Array => new Uint8Array(new Int16Array(samples).buffer);

describe("voiceLevel", () => {
  it("is 0 for silence and for no samples", () => {
    expect(voiceLevel(pcm())).toBe(0);
    expect(voiceLevel(pcm(0, 0, 0, 0))).toBe(0);
  });
  it("rises with loudness and stops at 1", () => {
    expect(voiceLevel(pcm(1000, -1000))).toBeGreaterThan(0);
    expect(voiceLevel(pcm(2000, -2000))).toBeGreaterThan(voiceLevel(pcm(1000, -1000)));
    expect(voiceLevel(pcm(30000, -30000))).toBe(1);
  });
});
