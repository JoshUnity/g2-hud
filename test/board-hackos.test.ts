import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoScreen, demoView } from "../src/hackos/demo";
import { bootScreen, hackScreen, screenTexts } from "../src/hackos/view";
import { renderHack } from "../src/hackos/render";
import { crop, diffFrames, diffTexts, writeDiffPng } from "./board/compare";
import { boardFrame, boardOpeningT, boardReveal } from "./board/reference";

/** Where a failing comparison writes its diff picture. */
const OUT = `${tmpdir()}/g2-hud-diff/hackos`;
const TIMES = [0.4, 3.3, 7.9, 21.7];
const OPEN_R = [0.2, 0.45, 0.7, 0.93];
const CLOCK = "18:16";

function check(name: string, build: Uint8Array, board: ReturnType<typeof boardFrame>): void {
  const diff = diffFrames(build, board.pixels);
  if (diff.different) {
    mkdirSync(OUT, { recursive: true });
    writeDiffPng(`${OUT}/${name}.png`, build, board.pixels);
  }
  expect(diff.different, `${name} differs, first at ${JSON.stringify(diff.first)}`).toBe(0);
}

describe("HackOS against the board", () => {
  for (const [scene, screen] of [["waking", "waking"], ["done", "answer"]] as const) {
    for (const t of TIMES) {
      it(`${screen} at t = ${t}: the raster has no differing pixel and the text matches`, () => {
        const board = boardFrame("hackos", screen, t);
        const s = demoScreen(scene, t);
        expect(s).not.toBeNull();
        if (!s) return;
        check(`hackos-${screen}-${t}`, renderHack(s, { t, clock: CLOCK }), board);
        expect(diffTexts(screenTexts(s), board.texts)).toEqual({ missing: [], extra: [] });
      });
    }
  }
  for (const r of OPEN_R) {
    it(`the opening at ${r}: the raster has no differing pixel and the text matches`, () => {
      const t = boardOpeningT("hackos", r);
      const board = boardFrame("hackos", "intro", t);
      const s = demoScreen("done", t);
      if (!s) throw new Error("no done scene");
      const open = bootScreen(s);
      check(`hackos-open-${r}`, renderHack(open, { t, clock: CLOCK, reveal: boardReveal("hackos", r) }), board);
      expect(diffTexts(screenTexts(open), board.texts)).toEqual({ missing: [], extra: [] });
    });
  }

  // The thinking and answering cores are the board's resting core: the same region of the lens, the same pixels.
  const CORE_REGION = { x: 410, y: 80, width: 166, height: 176 };
  for (const state of ["thinking", "answering", "transcribing"] as const) {
    for (const t of TIMES) {
      it(`${state} draws the board's resting core at t = ${t}`, () => {
        const view = { ...demoView("done", Date.now(), t)!, state, startedAt: Date.now() - 4000 };
        const s = hackScreen(view, 0, new Date());
        const build = renderHack(s, { t, clock: CLOCK });
        const board = boardFrame("hackos", "answer", t);
        const diff = diffFrames(crop(build, 576, CORE_REGION), crop(board.pixels, 576, CORE_REGION), { width: CORE_REGION.width });
        expect(diff.different, `${state} core differs, first at ${JSON.stringify(diff.first)}`).toBe(0);
      });
    }
  }
});
