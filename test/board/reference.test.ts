import { describe, expect, it } from "vitest";
import { crop, diffFrames, diffTexts } from "./compare";
import { BOARD_H, BOARD_OPEN, BOARD_SCREENS, BOARD_W, boardFrame, boardIntroT, boardOpeningT, boardReveal, type BoardApp } from "./reference";

describe("board reference", () => {
  it("draws sky live with lit pixels and the Sky label at (332, 0) in light 3", () => {
    const { pixels, texts } = boardFrame("sky", "live", 3.3);
    expect(pixels).toHaveLength(BOARD_W * BOARD_H);
    expect(pixels.some((v) => v > 0)).toBe(true);
    expect(pixels.reduce((m, v) => Math.max(m, v), 0)).toBe(15);
    expect(texts).toContainEqual({ text: "Sky", x: 332, y: 0, level: 3, align: "left" });
  });

  it("is the same for the same time and differs for another", () => {
    for (const app of Object.keys(BOARD_SCREENS) as BoardApp[]) {
      for (const screen of BOARD_SCREENS[app]) {
        const a = boardFrame(app, screen, 3.3);
        const b = boardFrame(app, screen, 3.3);
        expect(diffFrames(a.pixels, b.pixels, { buildLevels: true }).different, `${app} ${screen}`).toBe(0);
        expect(b.texts).toEqual(a.texts);
        expect(a.pixels.some((v) => v > 0)).toBe(true);
      }
    }
    const x = boardFrame("sky", "live", 3.3).pixels;
    const y = boardFrame("sky", "live", 3.9).pixels;
    expect(diffFrames(x, y, { buildLevels: true }).different).toBeGreaterThan(0);
  });

  it("records text lines at their line top, with the engine's lights", () => {
    const { texts } = boardFrame("answers", "answer", 3.3);
    expect(texts.find((t) => t.text === "Answer")).toEqual({ text: "Answer", x: 32, y: 0, level: 3, align: "left" });
    expect(texts.find((t) => t.text.startsWith("• Mostly"))).toMatchObject({ x: 0, y: 72, level: 4 });
    expect(new Set(texts.map((t) => t.level))).toEqual(new Set([2, 3, 4]));
  });

  it("measures text with the glasses font", async () => {
    const { textWidth } = await import("../../src/core/text");
    // Around puts "3 ALERTS" after the label: its x depends on the measured width.
    const { pixels } = boardFrame("around", "live", 3.3);
    const x = 46 + textWidth("Harbour Quarter");
    expect(pixels.some((v, i) => v > 0 && i % BOARD_W >= x && i % BOARD_W < x + 4 && Math.floor(i / BOARD_W) >= 11 && Math.floor(i / BOARD_W) < 18)).toBe(true);
  });

  it("runs the intro on the engine's clock: logo, opening, then the live screen", () => {
    const logo = boardFrame("sky", "intro", boardIntroT(1100));
    expect(crop(logo.pixels, BOARD_W, { x: 240, y: 70, width: 96, height: 96 }).some((v) => v > 0)).toBe(true);
    expect(logo.texts.map((t) => t.text)).toEqual(["Sky"]);
    const half = boardFrame("sky", "intro", boardOpeningT("sky", 0.5));
    const live = boardFrame("sky", "live", boardOpeningT("sky", 0.5));
    expect(diffFrames(half.pixels, live.pixels, { buildLevels: true }).different).toBeGreaterThan(0); // mid-opening is not the live screen
    const after = boardFrame("sky", "intro", boardOpeningT("sky", 1) + 0.01);
    expect(after.texts.some((t) => t.text === "Sky")).toBe(true);
    expect(boardOpeningT("hackos", 0.5)).toBeCloseTo((1600 + 0.5 * BOARD_OPEN.hackos.ms) / 1000, 9);
    expect(boardReveal("around", 0.5)).toBe(0.5);
    expect(boardReveal("around", 0.25)).toBeCloseTo(0.15625, 9);
    expect(boardReveal("sky", 0.25)).toBe(0.25);
  });
});

describe("compare", () => {
  it("compares by level and finds the first different pixel and the bounds", () => {
    const board = new Uint8Array(576 * 288);
    const build = new Uint8Array(576 * 288);
    board[5 * 576 + 7] = 15;
    board[9 * 576 + 20] = 4;
    build[5 * 576 + 7] = 255; // level 15
    build[9 * 576 + 20] = 119; // level 7, not 4
    build[10 * 576 + 3] = 17;
    const d = diffFrames(build, board);
    expect(d.different).toBe(2);
    expect(d.first).toEqual({ x: 20, y: 9, build: 7, board: 4 });
    expect(d.bounds).toEqual({ x: 3, y: 9, width: 18, height: 2 });
    expect(diffFrames(new Uint8Array(4), new Uint8Array(4), { width: 2 })).toEqual({ different: 0, first: null, bounds: null });
  });

  it("compares text as a set of word, place and light", () => {
    const board = [
      { text: "A", x: 0, y: 36, level: 2, align: "left" as const },
      { text: "B", x: 5, y: 72, level: 4, align: "left" as const },
    ];
    expect(diffTexts([{ text: "B", x: 5, y: 72, level: 4 }, { text: "A", x: 0, y: 36, level: 2 }], board)).toEqual({ missing: [], extra: [] });
    const bad = diffTexts([{ text: "A", x: 0, y: 36, level: 3 }], board);
    expect(bad.missing).toHaveLength(2);
    expect(bad.extra).toHaveLength(1);
  });
});
