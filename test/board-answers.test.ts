import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { lensCanvas } from "../src/core/board";
import { boardEnv, boardVault, scene, SARAH } from "../src/answers/demo";
import { drawLens } from "../src/answers/lens";
import { TEXT_BOXES } from "../src/answers/pages";
import { initialState, screen, type Env, type HudState, type Screen } from "../src/answers/view";
import { LINE } from "../src/core/text";
import { diffFrames, diffTexts, writeDiffPng, type BuildText } from "./board/compare";
import { boardFrame, boardOpeningT } from "./board/reference";

/** Answers against the board: the lens raster level for level, and the glasses text as data. */

const SCRATCH = `${tmpdir()}/g2-hud-diff/answers`;
const NOW = 1_700_000_000_000;
const vault = boardVault();

/** The demo state for a scene: the board's vault, and for the recall scene the cue drawn and on the lens. */
function demoState(name: string): HudState {
  const sc = scene(name, NOW);
  const state: HudState = { ...initialState(), ...sc.state, vault };
  if (sc.cue) state.cue = { ...SARAH, arrivedAt: NOW, shownAt: NOW, onLensAt: NOW, seen: false };
  return state;
}

/** What the glasses show as text: each container's lines, line i at the container's y + 27 i. */
function textsOf(s: Screen): BuildText[] {
  const cells = { status: s.status, question: s.question, body: s.body, hint: s.hint, card1: s.card[0], card2: s.card[1], card3: s.card[2], card4: s.card[3] };
  return TEXT_BOXES.flatMap((box) => {
    const cell = cells[box.name as keyof typeof cells];
    return cell.content === "" ? [] : cell.content.split("\n").map((text, i) => ({ text, x: box.x, y: box.y + i * LINE, level: cell.color })).filter((t) => t.text !== "");
  });
}

function check(label: string, board: ReturnType<typeof boardFrame>, state: HudState, env: Env): void {
  const s = screen(state, new Date(NOW), env);
  const canvas = lensCanvas();
  drawLens(canvas, s.lens, env.t);
  const diff = diffFrames(canvas.pixels, board.pixels);
  if (diff.different) writeDiffPng(`${SCRATCH}/${label}.png`, canvas.pixels, board.pixels);
  expect(diff, `${label} pixels`).toMatchObject({ different: 0 });
  expect(diffTexts(textsOf(s), board.texts), `${label} text`).toEqual({ missing: [], extra: [] });
}

describe("Answers against the board", () => {
  for (const [scene_, screen_] of [["idle", "listening"], ["recall", "recall"], ["sources", "answer"]] as const) {
    for (const t of [0.4, 3.3, 7.9, 21.7]) {
      it(`${screen_} at t = ${t}`, () => {
        check(`${screen_}-${t}`, boardFrame("answers", screen_, t), demoState(scene_), boardEnv(t));
      });
    }
  }
  for (const r of [0.2, 0.45, 0.7, 0.93]) {
    it(`the opening at r = ${r}`, () => {
      const t = boardOpeningT("answers", r);
      check(`open-${r}`, boardFrame("answers", "intro", t), demoState("idle"), { ...boardEnv(t), open: r });
    });
  }
});
