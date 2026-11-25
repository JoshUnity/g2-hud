import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoScene } from "../src/around/demo";
import { aroundTexts, incidentRows, renderAround } from "../src/around/render";
import { BOARD_LOGO_MS, boardFrame, boardOpeningT, boardReveal } from "./board/reference";
import { diffFrames, diffTexts, writeDiffPng } from "./board/compare";

/**
 * Around against the approved board, pixel for pixel: the demo scene draws the board's city through the real
 * renderer, and the glasses text matches the board's `tx` calls.
 */
const scene = demoScene("1");
const SCRATCH = process.env.AROUND_DIFF_DIR;

function check(label: string, t: number, reveal: number): void {
  const board = boardFrame("around", reveal < 1 || t < 0 ? "intro" : "live", t);
  const build = renderAround(scene.map, scene.osint, t, 0, true, reveal, { clock: scene.clock });
  const diff = diffFrames(build, board.pixels);
  if (diff.different && SCRATCH) {
    mkdirSync(SCRATCH, { recursive: true });
    writeDiffPng(`${SCRATCH}/${label}.png`, build, board.pixels);
  }
  expect(diff.different, `${label}: ${JSON.stringify(diff)}`).toBe(0);
  expect(diffTexts(aroundTexts(scene.osint, incidentRows(scene.osint)), board.texts)).toEqual({ missing: [], extra: [] });
}

describe("Around equals the board", () => {
  for (const t of [0.4, 3.3, 7.9, 21.7]) it(`live at t = ${t}`, () => check(`live-${t}`, t, 1));
  for (const r of [0.05, 0.2, 0.3, 0.45, 0.6, 0.7, 0.85, 0.93, 0.99]) {
    it(`opening at progress ${r}`, () => check(`open-${r}`, boardOpeningT("around", r), boardReveal("around", r)));
  }
  it("the opening ends on the live picture", () => {
    expect(BOARD_LOGO_MS).toBe(1600);
    check("settled", boardOpeningT("around", 1.2), 1);
  });
});
