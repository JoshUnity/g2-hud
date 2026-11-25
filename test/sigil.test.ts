import { describe, expect, it } from "vitest";
import { EDGES, VERTICES, renderSigil, sigilFps } from "../src/answers/sigil";

describe("Sigil", () => {
  it("is an icosahedron", () => {
    expect(VERTICES).toHaveLength(12);
    expect(EDGES).toHaveLength(30);
  });
  it("draws inside its square, with both bright and dim edges", () => {
    const frame = renderSigil("listening", 1.3, 1.3, 0.2, 64);
    expect(frame).toHaveLength(64 * 64);
    const lit = [...frame].filter((v) => v > 0);
    expect(lit.length).toBeGreaterThan(200);
    expect(Math.max(...lit)).toBeGreaterThan(200);
    expect(Math.min(...lit)).toBeLessThan(80);
  });
  it("moves over time, except when paused", () => {
    expect(renderSigil("thinking", 1, 1, 0)).not.toEqual(renderSigil("thinking", 1.2, 1.2, 0));
    expect(renderSigil("paused", 1, 1, 0)).toEqual(renderSigil("paused", 9, 9, 0));
  });
  it("only animates fast when something is happening", () => {
    expect(sigilFps("paused", 5, 0)).toBe(0);
    expect(sigilFps("listening", 5, 0)).toBe(3);
    expect(sigilFps("listening", 5, 0.5)).toBe(8);
    expect(sigilFps("answer", 5, 0)).toBe(2);
  });
});
