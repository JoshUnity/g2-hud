import { describe, expect, it } from "vitest";
import { type MarkMode, markFps, renderMark } from "../src/code/mark";

const lit = (frame: Uint8Array) => frame.filter((v) => v > 0).length;
const brightest = (frame: Uint8Array) => Math.max(...frame);
/** Lit pixels in the cursor cell (x 36 to 55), where the states differ most. */
const cursorLit = (frame: Uint8Array) => {
  let n = 0;
  for (let y = 0; y < 64; y++) for (let x = 36; x < 56; x++) if ((frame[y * 64 + x] ?? 0) > 0) n++;
  return n;
};

describe("Code mark", () => {
  it("draws 64 x 64 frames with anti-aliased edges and most pixels off", () => {
    for (const mode of ["off", "idle", "recording", "working", "approval", "done", "error"] as MarkMode[]) {
      const frame = renderMark(mode, 0.4, 0.4, 0.3);
      expect(frame).toHaveLength(64 * 64);
      expect(lit(frame)).toBeGreaterThan(200);
      expect(lit(frame)).toBeLessThan(64 * 64 * 0.25);
      // In-between grey levels (of the 16 the glasses show) on the edges.
      expect(new Set([...frame].filter((v) => v > 0).map((v) => v >> 4)).size).toBeGreaterThanOrEqual(3);
    }
    expect(renderMark("idle", 0, 0, 0, 32)).toHaveLength(32 * 32);
  });

  it("shows each state in a different form", () => {
    const frames = new Map<string, Uint8Array>([
      ["off", renderMark("off", 1, 1, 0)],
      ["idle", renderMark("idle", 1, 1, 0)],
      ["recording", renderMark("recording", 1, 1, 0)],
      ["working", renderMark("working", 1, 1, 0)],
      ["approval", renderMark("approval", 1, 1, 0)],
      ["done", renderMark("done", 0.2, 0.2, 0)],
      ["error", renderMark("error", 1, 1, 0)],
    ]);
    const names = [...frames.keys()];
    for (const a of names) for (const b of names) if (a < b) expect(frames.get(a), `${a} vs ${b}`).not.toEqual(frames.get(b));
  });

  it("rests when idle", () => {
    expect(renderMark("idle", 1, 5, 0)).toEqual(renderMark("idle", 2, 9, 0.8));
    expect(renderMark("off", 1, 5, 0)).toEqual(renderMark("off", 2, 9, 0));
    expect(markFps("idle", 5, 0)).toBe(0);
    expect(markFps("off", 5, 0)).toBe(0);
  });

  it("raises the cursor with your voice while recording", () => {
    const quiet = cursorLit(renderMark("recording", 1, 1, 0));
    const loud = cursorLit(renderMark("recording", 1, 1, 1));
    expect(loud).toBeGreaterThan(quiet * 3);
    // Never the full block: a loud voice must not make the recording mark look idle.
    expect(loud).toBeLessThan(cursorLit(renderMark("idle", 1, 1, 0)));
    expect(markFps("recording", 1, 0)).toBe(4);
    expect(markFps("recording", 1, 0.5)).toBe(8);
  });

  it("moves steadily while working", () => {
    expect(renderMark("working", 1, 1, 0)).not.toEqual(renderMark("working", 1.2, 1.2, 0));
    expect(renderMark("working", 1.2, 1.2, 0)).not.toEqual(renderMark("working", 1.325, 1.325, 0));
    expect(markFps("working", 1, 0)).toBe(8);
  });

  it("pulses the whole mark once a second while waiting for approval, never looking idle", () => {
    const peak = renderMark("approval", 0.25, 1, 0);
    const trough = renderMark("approval", 0.75, 1, 0);
    expect(brightest(peak)).toBeGreaterThan(brightest(trough) + 80);
    expect(renderMark("approval", 1.25, 2, 0)).toEqual(peak);
    // The chevron pulses too, not only the cursor.
    expect(peak[32 * 64 + 30]).toBeGreaterThan(trough[32 * 64 + 30] ?? 0);
    for (let t = 0; t < 1; t += 0.125) expect(renderMark("approval", t, 1, 0)).not.toEqual(renderMark("idle", t, 1, 0));
    expect(markFps("approval", 1, 0)).toBe(4);
  });

  it("plays a short flourish when done, then rests", () => {
    expect(renderMark("done", 0.1, 0.1, 0)).not.toEqual(renderMark("done", 0.4, 0.4, 0));
    expect(renderMark("done", 3, 3, 0)).toEqual(renderMark("idle", 3, 3, 0));
    expect(markFps("done", 0.5, 0)).toBe(8);
    expect(markFps("done", 2, 0)).toBe(0);
  });

  it("shows an error dim and broken, and still", () => {
    const error = renderMark("error", 1, 1, 0);
    expect(brightest(error)).toBeLessThanOrEqual(120);
    expect(error).not.toEqual(renderMark("off", 1, 1, 0));
    expect(error).toEqual(renderMark("error", 7, 7, 0));
    expect(markFps("error", 1, 0)).toBe(0);
  });
});
