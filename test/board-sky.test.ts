import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lensCanvas } from "../src/core/board";
import { BOARD_PLANES } from "../src/sky/demo";
import { renderSkyLens, skyTexts, type SkyModel } from "../src/sky/render";
import { diffFrames, diffTexts, writeDiffPng } from "./board/compare";
import { BOARD_LOGO_MS, BOARD_OPEN, boardFrame, boardOpeningT } from "./board/reference";

/** Where a failing comparison writes its picture (board | build | diff). */
const SCRATCH = `${tmpdir()}/g2-hud-diff/sky`;

/** The model the demo builds: the board's four aircraft, its clock, the sweep on. */
const boardModel = (open: number): SkyModel => ({
  planes: BOARD_PLANES,
  selectedId: null,
  showCount: true,
  message: null,
  noPosition: false,
  clock: "18:16",
  open,
  sweeping: true,
});

/** The engine's own opening progress at time t (what `RV` is for `intro`). */
const engineProgress = (t: number): number => ((t * 1000) % (BOARD_LOGO_MS + BOARD_OPEN.sky.ms + 3200) - BOARD_LOGO_MS) / BOARD_OPEN.sky.ms;

function compare(name: string, screen: string, t: number, open: number): { different: number; missing: unknown[]; extra: unknown[] } {
  const board = boardFrame("sky", screen, t);
  const canvas = lensCanvas();
  const model = boardModel(open);
  renderSkyLens(canvas, model, t);
  const diff = diffFrames(canvas.pixels, board.pixels);
  if (diff.different) {
    mkdirSync(SCRATCH, { recursive: true });
    writeDiffPng(`${SCRATCH}/${name}.png`, canvas.pixels, board.pixels);
  }
  return { different: diff.different, ...diffTexts(skyTexts(model), board.texts) };
}

describe("Sky is the board's sky.live, pixel for pixel", () => {
  it.each([0.4, 3.3, 7.9, 21.7, 60.2])("live at t = %s", (t) => {
    expect(compare(`live-${t}`, "live", t, 1)).toEqual({ different: 0, missing: [], extra: [] });
  });

  it.each([0.02, 0.1, 0.15, 0.2, 0.29, 0.3, 0.35, 0.44, 0.45, 0.6, 0.7, 0.8, 0.93, 0.999])("opening at progress %s", (r) => {
    const t = boardOpeningT("sky", r);
    expect(engineProgress(t)).toBeCloseTo(r, 6);
    expect(compare(`open-${r}`, "intro", t, engineProgress(t))).toEqual({ different: 0, missing: [], extra: [] });
  });

  it("is a real comparison: a different model does not pass", () => {
    const board = boardFrame("sky", "live", 3.3);
    const canvas = lensCanvas();
    renderSkyLens(canvas, boardModel(0.5), 3.3);
    expect(diffFrames(canvas.pixels, board.pixels).different).toBeGreaterThan(1000);
    expect(diffTexts(skyTexts({ ...boardModel(1), planes: BOARD_PLANES.slice(0, 3) }), board.texts).missing).toHaveLength(1);
  });
});
