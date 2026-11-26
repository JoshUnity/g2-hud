import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { lensCanvas } from "../src/core/board";
import { demoMoment } from "../src/code/demo";
import { BODY, CALL, FOLDER, HINT, PROMPT, STATUS, STEP, STEPS } from "../src/code/layout";
import { renderCodeLens } from "../src/code/lens";
import { buildLens, liveInput } from "../src/code/model";
import { codeScreen, screenTexts, tabStates } from "../src/code/view";
import { boardFrame, boardOpeningT, boardReveal } from "./board/reference";
import { diffFrames, diffTexts, writeDiffPng } from "./board/compare";

const SCRATCH = `${tmpdir()}/g2-hud-diff/code`;
const PLACES = Object.fromEntries([STATUS, PROMPT, STEPS, STEP, CALL, FOLDER, HINT, BODY].map((b) => [b.name, { x: b.x, y: b.y }]));
const TIMES = [0.4, 3.3, 7.9, 21.7, 64.2, 107.9];

/** The page's own path for a demo scene: the demo hub, the screen, the lens model and the raster. */
function build(scene: string, t: number, load = 1) {
  // The demo gives input only (the hub, the moment, when the request arrived); the page computes everything shown.
  const { hub, now, arrivedAt } = demoMoment(scene, t);
  const view = hub.tabs[0]!.view;
  const tabs = tabStates(hub, 1);
  const screen = codeScreen(view, 0, new Date(now), tabs, "", load);
  const canvas = lensCanvas();
  renderCodeLens(canvas, buildLens(screen, view, tabs, liveInput(view, arrivedAt, now, 0)), t, load);
  return { pixels: canvas.pixels, texts: screenTexts(screen, PLACES), screen };
}

function same(name: string, scene: string, board: ReturnType<typeof boardFrame>, t: number, load = 1): void {
  const got = build(scene, t, load);
  const diff = diffFrames(got.pixels, board.pixels);
  if (diff.different) writeDiffPng(`${SCRATCH}/${name}.png`, got.pixels, board.pixels);
  expect(diff, name).toMatchObject({ different: 0 });
  expect(diffTexts(got.texts, board.texts), name).toEqual({ missing: [], extra: [] });
}

describe("Code against the board", () => {
  for (const t of TIMES) {
    it(`working at t ${t}: every pixel and every glasses text line`, () => same(`working-${t}`, "working", boardFrame("code", "working", t), t));
    it(`allow at t ${t}: every pixel and every glasses text line`, () => same(`allow-${t}`, "approval", boardFrame("code", "allow", t), t));
  }
  for (const r of [0.05, 0.2, 0.35, 0.45, 0.6, 0.7, 0.85, 0.93]) {
    it(`the opening of working at progress ${r}`, () => {
      const t = boardOpeningT("code", r);
      same(`open-${r}`, "working", boardFrame("code", "intro", t), t, boardReveal("code", r));
    });
  }
});
