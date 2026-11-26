import { describe, expect, it } from "vitest";
import { lensCanvas } from "../src/core/board";
import { BODY_LINES } from "../src/core/hud";
import { Canvas, sameFrame } from "../src/core/pixels";
import { LINE, textWidth } from "../src/core/text";
import { SARAH, boardEnv, boardVault, scene } from "../src/answers/demo";
import { Voice, iconFrame, iconMoves, meterOf } from "../src/answers/header";
import { OPEN_OUT, RIBBON_COLUMNS, depthVis, drawLens, labelText, lensFps, nameFit, pagesX } from "../src/answers/lens";
import { BODY, CARD_LINES, HINT, QUESTION, STATUS, TEXT_BOXES, pageSpec } from "../src/answers/pages";
import { boardColumns, ribbonColumns } from "../src/answers/ribbon";
import { buildVault, findNode, linkedNodes, sourceNodes } from "../src/answers/vault";
import {
  CUE_MS,
  CUE_SEEN_MS,
  CUE_WAIT_MS,
  DIM_AFTER_MS,
  OPEN_MS,
  acceptCue,
  cardLines,
  cardProof,
  confirmCue,
  cueRoom,
  cueText,
  formatAnswer,
  idleEnv,
  initialState,
  openRatio,
  screen,
  stepCue,
  type HudCue,
  type HudState,
} from "../src/answers/view";

const at = new Date(2026, 10, 23, 13, 5);
const t = at.getTime();
const vault = boardVault();
const st = (patch: Partial<HudState>): HudState => ({ ...initialState(), ...patch });
const lit = (pixels: Uint8Array, min = 1): number => pixels.filter((v) => v >= min).length;

describe("vault", () => {
  it("maps ids to indexes and drops links to unknown ids", () => {
    const v = buildVault({
      nodes: [{ id: 10, title: "A", kind: "person" }, { id: 20, title: "B", kind: "topic" }, { id: 30, title: "C", kind: "meeting" }],
      links: [[10, 20], [20, 99], [30, 10], [10, 10]],
    });
    expect(v.graph.links).toEqual([[0, 1], [2, 0]]);
    expect(v.graph.points).toHaveLength(3);
    expect(v.people).toBe(1);
  });
  it("finds a person by id, then by title, and the linked and source nodes", () => {
    expect(findNode(vault, "Nobody", 0)).toBe(0);
    expect(findNode(vault, "  sarah CHEN ")).toBe(0);
    expect(findNode(vault, "Nobody")).toBeNull();
    expect(linkedNodes(vault, 0, 3)).toEqual([1, 2, 3]);
    expect(linkedNodes(vault, 0, 2)).toEqual([1, 2]);
    expect(sourceNodes(vault, ["pricing plan", "No such note", "Sarah Chen"])).toEqual([1, 0]);
  });
});


describe("screen", () => {
  it("shows the hint under a listening lens, and the clock", () => {
    const view = screen(st({ mode: "listening" }), at);
    expect(view.status).toEqual({ content: "Listening", color: 3 });
    expect(view.lens.clock).toBe("13:05");
    expect(view.hint).toEqual({ content: "Tap pause  ·  Double tap clear  ·  Hold save", color: 1 });
    expect(view.body.content).toBe("");
    expect(view.question.content).toBe("");
    expect(view.lens.view).toBe("listening");
    expect(view.lens.ribbon).toEqual({ columns: idleEnv(at).columns, dim: false });
    expect(view.icon).toBe("listening");
  });
  it("keeps the hint in its place when a two-line cue takes the question place", () => {
    const cue: HudCue = { ...SARAH, id: undefined, arrivedAt: t, shownAt: t, onLensAt: t, seen: false };
    const view = screen(st({ mode: "listening", cue }), at);
    expect(view.question.content).toBe(cueText(SARAH));
    expect(view.hint.content).toContain("Tap pause");
  });
  it("shows the connecting, paused, thinking and error states in the board's language", () => {
    expect(screen(st({}), at).status.content).toBe("Connecting");
    const paused = screen(st({ mode: "paused" }), at);
    expect([paused.status.content, paused.body.content, paused.lens.ribbon?.dim, paused.icon, paused.hint.content]).toEqual(["Paused", "Not listening.\n\nTap to listen again.", true, "paused", ""]);
    const thinking = screen(st({ mode: "thinking", question: "Why?" }), at);
    expect([thinking.status.content, thinking.question.content, thinking.question.color, thinking.lens.ribbon, thinking.lens.view]).toEqual(["Thinking", "“Why?”", 2, null, "plain"]);
    const error = screen(st({ mode: "error", error: "Not running." }), at);
    expect([error.status.content, error.body.content, error.body.color]).toEqual(["Check setup", "Not running.", 3]);
  });
  it("shows the question, the answer bright, and page squares instead of a page count", () => {
    const answer = Array.from({ length: 12 }, (_, i) => `- point number ${i}`).join("\n");
    const view = screen(st({ mode: "answer", question: "Why?", answer }), at);
    expect(view.question.content).toBe("“Why?”");
    expect(view.body.color).toBe(4);
    expect(view.status.content).toBe("Answer");
    expect(view.body.content.startsWith("• point number 7")).toBe(true);
    expect(view.pageCount).toBe(2);
    expect(view.lens.pages).toEqual({ count: 2, current: 1 });
    expect(view.icon).toBe("answer");
    expect(pagesX(2)).toBe(458);
  });
  it("makes pages of 7 lines that fit under a one-line and a two-line question", () => {
    const answer = Array.from({ length: 20 }, (_, i) => `- point number ${i}`).join("\n");
    const view = screen(st({ mode: "answer", question: "Why?", answer, follow: false, page: 0 }), at);
    expect(view.body.content.split("\n")).toHaveLength(7);
    expect(BODY_LINES).toBeGreaterThanOrEqual(8);
  });
  it("shows a caret while the answer streams, and dims an old answer", () => {
    expect(screen(st({ mode: "answer", answer: "Yes" }), at).body.content).toBe("Yes │");
    expect(screen(st({ mode: "answer", answer: "Yes.", answeredAt: t - DIM_AFTER_MS - 1 }), at).body.color).toBe(2);
    expect(screen(st({ mode: "answer", answer: "Yes.", answeredAt: t - 21_000 }), at).body.color).toBe(3);
  });
  it("shows a toast over the state, and the saved icon", () => {
    const view = screen(st({ mode: "listening", toast: { text: "Saved  ·  Call", until: t + 1 } }), at);
    expect(view.status.content).toBe("Saved  ·  Call");
    expect(view.icon).toBe("saved");
    const mic = screen(st({ mode: "listening", toast: { text: "Mic not available  ·  tap to retry or reopen", until: t + 1 } }), at);
    expect(textWidth(mic.status.content)).toBeLessThanOrEqual(STATUS.width);
  });
  it("wraps the board's sample where the board breaks it, with the orb at the right", () => {
    const view = screen(boardState("sources"), at);
    expect(view.body.content).toBe("• Mostly the route planner app at\n   Acme Freight.\n• This week: faster stock lookups\n   from depot records.\n• Happy to show you a demo later.");
    expect(view.lens.sources?.lit).toEqual([0, 1, 3]);
  });
  it("wraps at 320 px and shows the orb when the answer has notes the graph knows, and at the full width otherwise", () => {
    const base = { mode: "answer" as const, question: "What are you building at Acme Freight for the route planner this year?", answer: "- Mostly the route planner app at Acme Freight and a long line to wrap.", vault, answeredAt: t };
    expect(screen(st(base), at).lens.sources).toBeNull();
    const withNotes = screen(st({ ...base, notes: ["Sarah Chen", "Pricing plan", "Atlas migration", "Other"] }), at);
    expect(withNotes.lens.sources).toMatchObject({ lit: [0, 1, 3], count: 4, titles: ["Sarah Chen", "Pricing plan", "Atlas migration"] });
    for (const line of withNotes.body.content.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(320);
    for (const line of withNotes.question.content.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(440);
    expect(screen(st({ ...base, notes: ["Unknown"] }), at).lens.sources).toBeNull();
    expect(screen(st({ ...base, notes: ["Sarah Chen"], vault: null }), at).lens.sources).toBeNull();
  });
});

function boardState(name: string): HudState {
  const sc = scene(name, t);
  const state: HudState = { ...initialState(), ...sc.state, vault };
  if (sc.cue) state.cue = { ...SARAH, arrivedAt: t, shownAt: t, onLensAt: t, seen: false };
  return state;
}

describe("recall view", () => {
  const drawn = (patch: Partial<HudCue> = {}): HudCue => ({ ...SARAH, arrivedAt: t, shownAt: t, onLensAt: t, seen: false, ...patch });

  it("shows the person, up to 3 linked nodes and the card when the graph has the node", () => {
    const view = screen(st({ mode: "listening", vault, cue: drawn() }), at);
    expect(view.recall).toMatchObject({ focus: 0, linked: [1, 2, 3], name: "Sarah Chen", seen: "12 Nov", hasLast: true, hasOpen: true });
    expect(view.status.content).toBe("Recall");
    expect(view.card.map((c) => c.content)).toEqual(["Head of procurement", "Northwind  ·  met 4 times", "12 Nov  ·  Pricing plan", "Send the deck"]);
    expect(view.card.map((c) => c.color)).toEqual([3, 2, 3, 3]);
    expect(view.question.content).toBe("");
    expect(view.hint.content).toBe("");
    expect(view.lens.ribbon).toBeNull();
    expect(view.icon).toBe("answer");
  });
  it("finds the node by name when the cue has no id", () => {
    expect(screen(st({ mode: "listening", vault, cue: drawn({ id: undefined }) }), at).recall?.focus).toBe(0);
  });
  it("falls back to the two-line cue with no graph or no node", () => {
    for (const patch of [{ vault: null }, { vault, cue: drawn({ id: undefined, name: "Nobody Known" }) }]) {
      const view = screen(st({ mode: "listening", cue: drawn(), ...patch }), at);
      expect(view.recall).toBeNull();
      expect(view.card.every((c) => c.content === "")).toBe(true);
      expect(view.question.content.split("\n")).toHaveLength(2);
    }
  });
  it("shows the compact cue, not the recall view, under a dimmed answer", () => {
    const view = screen(st({ mode: "answer", question: "Why?", answer: "Yes.", answeredAt: t - DIM_AFTER_MS - 1, vault, cue: drawn() }), at);
    expect(view.recall).toBeNull();
    expect(view.question.content).toBe(cueText(SARAH));
  });
  it("ends after 10 s: the card and the question go blank", () => {
    const view = screen(st({ mode: "listening", vault, cue: drawn({ onLensAt: t - CUE_MS }) }), at);
    expect(view.recall).toBeNull();
    expect(view.card.every((c) => c.content === "")).toBe(true);
    expect(view.question.content).toBe("");
  });
  it("splits the card as the board does, and leaves out a part the server did not send", () => {
    expect(cardLines({ facts: ["x"], card: { lead: "Head of procurement, Northwind", met: 4 } })).toEqual(["Head of procurement", "Northwind  ·  met 4 times", "", ""]);
    expect(cardLines({ facts: ["x"], card: { lead: "Founder", met: 1 } })).toEqual(["Founder", "met 1 time", "", ""]);
    expect(cardLines({ facts: ["x"], card: { last: "1 Sep  ·  Lunch", open: "Call back" } })).toEqual(["", "", "1 Sep  ·  Lunch", "Call back"]);
    expect(cardLines({ facts: ["12 Nov  ·  Pricing plan", "Open: Send the deck", "Head"] })).toEqual(["12 Nov  ·  Pricing plan", "Open: Send the deck", "", ""]);
    expect(cardProof({ facts: ["x"], card: { last: "1 Sep" } })).toBe("1 Sep");
    const lines = cardLines({ facts: ["x"], card: { lead: "a".repeat(200) } });
    expect(textWidth(lines[0])).toBeLessThanOrEqual(272);
    const view = screen(st({ mode: "listening", vault, cue: drawn({ card: { lead: "Founder" } }) }), at);
    expect(view.recall).toMatchObject({ seen: null, hasLast: false, hasOpen: false });
  });
});

describe("recall cue timing", () => {
  const sarah = { name: SARAH.name, facts: SARAH.facts };
  const waiting = (arrivedAt = t): HudCue => ({ ...sarah, id: undefined, arrivedAt, shownAt: null, seen: false });
  const drawn = (shownAt = t, seen = false): HudCue => ({ ...sarah, id: undefined, arrivedAt: shownAt, shownAt, onLensAt: shownAt, seen });

  it("writes the compact cue in pixels, two lines at most", () => {
    const [one, two] = cueText(sarah).split("\n");
    expect(one?.startsWith("SARAH CHEN  ·  12 Nov")).toBe(true);
    expect(textWidth(one ?? "")).toBeLessThanOrEqual(576);
    expect(textWidth(two ?? "")).toBeLessThanOrEqual(576);
    expect(cueText({ name: "Dana Scott", facts: ["1 Sep  ·  Lunch with Dana"] })).toBe("DANA SCOTT  ·  1 Sep  ·  Lunch with Dana");
  });
  it("finds room only while listening or under a dimmed answer", () => {
    const answered = (ago: number) => st({ mode: "answer", answer: "Yes.", answeredAt: t - ago });
    const table: [string, HudState, boolean, boolean][] = [
      ["listening", st({ mode: "listening" }), false, true],
      ["answer 31 s ago", answered(31_000), false, true],
      ["thinking", st({ mode: "thinking" }), false, false],
      ["answer 5 s ago", answered(5_000), false, false],
      ["paused", st({ mode: "paused" }), false, false],
      ["thinking, drawn", st({ mode: "thinking" }), true, true],
    ];
    for (const [name, state, isDrawn, room] of table) expect([name, cueRoom(state, t, isDrawn)]).toEqual([name, room]);
  });
  it("draws a waiting cue, reports seen at 3 s on the lens, and drops it at 10 s", () => {
    expect(stepCue(st({ mode: "listening", cue: waiting() }), t)).toEqual({ cue: { ...waiting(), shownAt: t }, drawn: true, seen: false });
    const state = st({ mode: "listening", cue: drawn() });
    expect(stepCue(state, t + CUE_SEEN_MS - 1).seen).toBe(false);
    expect(stepCue(state, t + CUE_SEEN_MS)).toEqual({ cue: drawn(t, true), drawn: false, seen: true });
    expect(stepCue(state, t + CUE_MS)).toEqual({ cue: null, drawn: false, seen: false });
  });
  it("counts from the accepted upgrade, which is the first card line in the recall view or the question text in the compact cue", () => {
    const unconfirmed: HudCue = { ...sarah, arrivedAt: t, shownAt: t, seen: false };
    expect(stepCue(st({ mode: "listening", cue: unconfirmed }), t + CUE_SEEN_MS + 1000).seen).toBe(false);
    expect(confirmCue(unconfirmed, "“Why?”", t + 2000)).toBe(unconfirmed);
    expect(confirmCue(waiting(), cardProof(sarah), t + 2000)).toEqual(waiting());
    expect(confirmCue(unconfirmed, cardProof(sarah), t + 2000)).toEqual({ ...unconfirmed, onLensAt: t + 2000 });
    expect(confirmCue(unconfirmed, cueText(sarah), t + 2000)).toEqual({ ...unconfirmed, onLensAt: t + 2000 });
    const onLens = confirmCue(unconfirmed, cardProof(sarah), t + 2000);
    expect(confirmCue(onLens, cardProof(sarah), t + 2500)).toBe(onLens);
    expect(stepCue(st({ mode: "listening", cue: onLens }), t + 2000 + CUE_SEEN_MS).seen).toBe(true);
  });
  it("goes back to waiting when an answer starts before 3 s, and is dropped once seen", () => {
    const streaming = { mode: "answer" as const, question: "Q?", answer: "Ye", answeredAt: null };
    expect(stepCue(st({ ...streaming, cue: drawn() }), t + 1000).cue).toEqual(waiting());
    expect(stepCue(st({ ...streaming, cue: drawn(t, true) }), t + 4000).cue).toBeNull();
  });
  it("drops a waiting cue after 60 s", () => {
    expect(stepCue(st({ mode: "paused", cue: waiting() }), t + CUE_WAIT_MS + 1).cue).toBeNull();
  });
  it("replaces a waiting cue, keeps a drawn cue of another name, and carries the node id", () => {
    const mark = { name: "Mark Olsen", facts: ["Open: Call back"] };
    expect(acceptCue(waiting(), mark, t + 5)).toEqual({ ...mark, id: undefined, arrivedAt: t + 5, shownAt: null, seen: false });
    expect(acceptCue(drawn(), mark, t + 5)).toEqual(drawn());
    expect(acceptCue(null, { ...sarah, id: 7 }, t).id).toBe(7);
  });
});


describe("page", () => {
  it("has 4 tiles and 8 text containers with unique ids and names, one event capture, and fits the limits", () => {
    const page = pageSpec({});
    const all = [...(page.imageObject ?? []), ...(page.textObject ?? [])];
    expect(all).toHaveLength(page.containerTotalNum ?? -1);
    expect(page.imageObject).toHaveLength(4);
    expect(page.textObject).toHaveLength(8);
    expect(new Set(all.map((c) => c.containerID)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.containerName)).size).toBe(all.length);
    expect(all.every((c) => (c.containerName ?? "").length <= 16)).toBe(true);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    const z = all.map((c) => c.zOrderIndex);
    expect(new Set(z).size).toBe(all.length);
    expect(Math.max(...z.slice(0, 4).map(Number))).toBeLessThan(Math.min(...z.slice(4).map(Number)));
  });
  it("puts the text where the board draws it, one line high or a whole number of lines", () => {
    expect([STATUS, QUESTION, BODY, HINT].map((b) => [b.x, b.y])).toEqual([[32, 0], [0, 36], [0, 72], [0, 255]]);
    expect(CARD_LINES.map((b) => [b.x, b.y])).toEqual([[304, 82], [304, 109], [304, 154], [304, 198]]);
    for (const box of TEXT_BOXES) expect(box.height % LINE).toBe(0);
    expect(BODY.y + BODY.height).toBeLessThanOrEqual(288);
    expect(STATUS.x + STATUS.width).toBeLessThanOrEqual(518);
  });
});

describe("lens parts", () => {
  it("makes the ribbon's columns from the voice history: silent is the baseline, the newest sample is at the centre", () => {
    const quiet = ribbonColumns(new Array<number>(40).fill(0));
    expect(quiet).toHaveLength(RIBBON_COLUMNS);
    expect(quiet.every((n) => n === 0)).toBe(true);
    const voice = new Voice();
    for (let i = 0; i < 12; i++) voice.push(0.9);
    const loud = ribbonColumns(voice.history);
    expect(loud[36]).toBeGreaterThanOrEqual(4);
    expect(Math.max(...loud)).toBeLessThanOrEqual(5);
    expect(loud.filter((n) => n > 0).length).toBeGreaterThan(30);
    const one = new Voice();
    one.push(1);
    one.push(1);
    expect(ribbonColumns(one.history)[36]).toBeGreaterThan(0);
    expect(ribbonColumns(one.history)[0]).toBe(0);
  });
  it("makes the board's own columns for the demo", () => {
    const cols = boardColumns(3.3);
    expect(cols).toHaveLength(73);
    expect(cols[0]).toBe(0);
    expect(Math.max(...cols)).toBeLessThanOrEqual(5);
  });
  it("cuts a label to 18 characters in capitals, and fits a name", () => {
    expect(labelText("Atlas migration roadmap for next year")).toBe("ATLAS MIGRATION RO");
    expect(nameFit("Sarah Chen")).toEqual({ text: "SARAH CHEN", scale: 3, dots: true });
    const long = nameFit("Alexandria Konstantinopoulos-Fitzgerald");
    expect(long.scale).toBe(2);
    expect(long.dots).toBe(false);
    expect(long.text.endsWith("...")).toBe(true);
    expect(long.text.length * 12 - 2).toBeLessThanOrEqual(264);
  });
  it("shows the farthest nodes first in a reveal", () => {
    const pts = [{ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.5 }];
    expect(depthVis(0.5)(pts)).toEqual([false, true, false, true]);
    expect(depthVis(1)(pts)).toEqual([true, true, true, true]);
    expect(depthVis(1, 1)(pts)).toEqual([false, false, false, false]);
  });
  it("asks for frames only when something moves", () => {
    const base = screen(st({ mode: "answer", answer: "Yes.", answeredAt: t }), at).lens;
    expect(lensFps(base, { icon: false, meter: false })).toBe(0);
    expect(lensFps(base, { icon: false, meter: true })).toBe(4);
    expect(lensFps(screen(st({ mode: "listening" }), at).lens, { icon: true, meter: false })).toBe(2);
    expect(lensFps(screen(st({ mode: "paused" }), at).lens, { icon: false, meter: false })).toBe(0);
    expect(lensFps(screen(st({ mode: "listening", vault, cue: { ...SARAH, arrivedAt: t, shownAt: t, onLensAt: t, seen: false } }), at).lens, { icon: false, meter: false })).toBe(2);
  });
  it("draws a lens with the same pixels every time for the same model and time", () => {
    const model = screen(boardState("recall"), at, boardEnv(3.3)).lens;
    const a = lensCanvas();
    const b = lensCanvas();
    drawLens(a, model, 3.3);
    drawLens(b, model, 3.3);
    expect(sameFrame(a.pixels, b.pixels)).toBe(true);
    const c = lensCanvas();
    drawLens(c, model, 4.3);
    expect(sameFrame(a.pixels, c.pixels)).toBe(false);
  });
});

describe("header icon", () => {
  const cells = (g: readonly string[], char: string): number => g.join("").split(char).length - 1;

  it("answer is all lit, paused is the ring only, connecting is all dim", () => {
    const answer = iconFrame("answer", 0, 0, 0);
    expect(cells(answer, "+")).toBe(0);
    const paused = iconFrame("paused", 0, 0, 0);
    expect(cells(paused, "#")).toBeLessThan(cells(answer, "#"));
    expect(cells(iconFrame("connecting", 0, 0, 0), "#")).toBe(0);
    expect(iconFrame("paused", 0, 0, 0)).toEqual(iconFrame("paused", 9, 9, 0));
  });
  it("error turns every third ring cell off", () => {
    expect(cells(iconFrame("error", 0, 0, 0), ".") - cells(iconFrame("connecting", 0, 0, 0), ".")).toBeGreaterThan(5);
  });
  it("listening breathes every 0.8 s and a loud voice keeps the core lit", () => {
    expect(iconFrame("listening", 0.1, 0, 0)).not.toEqual(iconFrame("listening", 0.9, 0, 0));
    expect(iconFrame("listening", 0.9, 0, 1)).toEqual(iconFrame("listening", 0.1, 0, 1));
    expect(cells(iconFrame("listening", 0.9, 0, 0), "+")).toBeGreaterThan(0);
  });
  it("thinking runs an arc of 8 lit ring cells that moves", () => {
    const a = iconFrame("thinking", 0, 0, 0);
    const b = iconFrame("thinking", 0.5, 0, 0);
    expect(a).not.toEqual(b);
    expect(cells(a, "+")).toBe(cells(b, "+"));
    expect(cells(a, "+")).toBeGreaterThan(10);
  });
  it("saved flashes off then fully lit, then takes the listening form", () => {
    expect(cells(iconFrame("saved", 0, 0.05, 0), "#")).toBe(0);
    expect(cells(iconFrame("saved", 0, 0.3, 0), "+")).toBe(0);
    expect(iconFrame("saved", 0.1, 2, 0)).toEqual(iconFrame("listening", 0.1, 2, 0));
  });
  it("moves by itself only while listening, thinking or saved", () => {
    expect([iconMoves("listening"), iconMoves("thinking"), iconMoves("saved")]).toEqual([true, true, true]);
    expect([iconMoves("answer"), iconMoves("paused"), iconMoves("error"), iconMoves("connecting")]).toEqual([false, false, false, false]);
  });
  it("gives the meter the newest five voice samples, the newest at the right", () => {
    const voice = new Voice();
    for (const v of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) voice.push(v);
    expect(meterOf(voice.history)).toEqual([0.2, 0.3, 0.4, 0.5, 0.6]);
  });
  it("keeps a voice history of recent levels, newest first", () => {
    const voice = new Voice();
    expect(voice.active).toBe(false);
    voice.push(0.5);
    voice.push(2);
    expect(voice.history.slice(0, 3)).toEqual([1, 0.5, 0]);
    expect(voice.active).toBe(true);
    expect(voice.history).toHaveLength(40);
  });
});


describe("demo scenes", () => {
  it("has every scene in the brief", () => {
    for (const name of ["idle", "speaking", "thinking", "answer", "long", "sources", "paused", "saved", "error", "recall", "cue"]) {
      expect(scene(name, t).state.mode).toBeDefined();
    }
    expect(scene("sources", t).state.notes).toHaveLength(3);
    expect(scene("cue", t).vault).toBe(false);
    expect(scene("recall", t).cue).toBe(true);
    expect(vault.nodes).toHaveLength(40);
    expect(vault.total).toEqual({ notes: 214, people: 11 });
  });
});

describe("the opening", () => {
  const blank = new Uint8Array(576 * 288);
  const frame = (r: number | null, tt: number, v = vault): Uint8Array => {
    const c = lensCanvas();
    drawLens(c, screen(st({ mode: "listening", vault: v }), at, { ...boardEnv(tt), open: r }).lens, tt);
    return c.pixels;
  };

  it("draws the vault from the far side: at 30% only some nodes, fewer than at the hold", () => {
    expect(lit(frame(0.3, 2.5))).toBeLessThan(lit(frame(0.68, 2.5)));
    expect(lit(frame(0.3, 2.5))).toBeGreaterThan(lit(frame(0, 2.5)));
  });
  it("is the normal listening frame at progress 1, and with no vault only the ribbon grows", () => {
    expect(sameFrame(frame(null, 3.3), frame(1, 3.3))).toBe(true);
    expect(lit(frame(0.1, 2, null as never))).toBeLessThanOrEqual(lit(frame(null, 2)));
    expect(OPEN_OUT).toBe(0.82);
  });
  it("renders the same frames for a frozen progress", () => {
    expect(sameFrame(frame(0.5, 2.9), frame(0.5, 2.9))).toBe(true);
  });
  it("is on only while the state is plain listening, ends at 3 s, and a state change ends it at once", () => {
    const t0 = 1000;
    expect(openRatio(st({ mode: "listening" }), t0, t0 + OPEN_MS / 2, null)).toBeCloseTo(0.5);
    expect(openRatio(st({ mode: "listening" }), t0, t0 + OPEN_MS, null)).toBeNull();
    expect(openRatio(st({ mode: "listening" }), null, t0, null)).toBeNull();
    for (const patch of [{ mode: "thinking" as const }, { mode: "answer" as const, answer: "Yes." }, { mode: "paused" as const }, { mode: "error" as const }, { mode: "connecting" as const }]) {
      expect(openRatio(st(patch), t0, t0 + 100, null)).toBeNull();
    }
    const cue: HudCue = { ...SARAH, arrivedAt: t0, shownAt: null, seen: false };
    expect(openRatio(st({ mode: "listening", cue }), t0, t0 + 100, null)).toBeNull();
    expect(openRatio(st({ mode: "listening", toast: { text: "Saved", until: t0 + 9999 } }), t0, t0 + 100, null)).toBeCloseTo(100 / OPEN_MS);
  });
  it("holds a frozen progress, still ending on a state change", () => {
    expect(openRatio(st({ mode: "listening" }), null, 5, 0.4)).toBe(0.4);
    expect(openRatio(st({ mode: "listening" }), null, 5, 7)).toBe(1);
    expect(openRatio(st({ mode: "thinking" }), null, 5, 0.4)).toBeNull();
  });
  it("says NOTE and PERSON for a vault of one, and keeps the board's words for the demo vault", () => {
    const one = buildVault({ nodes: [{ id: 1, title: "Sarah Chen", kind: "person" }], links: [], total: { notes: 1, people: 1 } });
    const text = (v: typeof vault): Canvas => {
      const c = new Canvas(576, 288);
      c.textRight(560, 88, `${Math.round(v.total!.people * 0.68)} ${v.total!.people === 1 ? "PERSON" : "PEOPLE"}`, 255);
      return c;
    };
    const f = frame(0.68, 3, one);
    expect(text(one).pixels.every((v, i) => v === 0 || (f[i] ?? 0) > 0)).toBe(true);
    // Without totals the counts are left out: the words stay, the numbers do not.
    const none = buildVault({ nodes: [{ id: 1, title: "Sarah Chen", kind: "person" }], links: [] });
    expect(lit(frame(0.68, 3, none))).toBeLessThan(lit(frame(0.68, 3)));
    expect(blank.length).toBe(576 * 288);
  });
});

describe("formatAnswer", () => {
  it("turns dash and star bullets into dots", () => {
    expect(formatAnswer("- one\n* two")).toBe("• one\n• two");
  });
});
