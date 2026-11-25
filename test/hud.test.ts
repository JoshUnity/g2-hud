import { describe, expect, it } from "vitest";
import {
  CUE_MS,
  CUE_SEEN_MS,
  CUE_WAIT_MS,
  DIM_AFTER_MS,
  LIGHT,
  acceptCue,
  clip,
  confirmCue,
  cueRoom,
  cueText,
  fitBytes,
  formatAnswer,
  initialState,
  paginate,
  screen,
  stepCue,
  wrap,
  type HudCue,
  type HudState,
} from "../src/answers/hud";
import { MAX_TEXT_BYTES } from "../src/core/text";

const at = new Date(2026, 10, 23, 13, 5);

describe("wrap and paginate", () => {
  it("wraps on word boundaries", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });
  it("keeps paragraph breaks and splits long words", () => {
    expect(wrap("abcdefghij\n\nok", 4)).toEqual(["abcd", "efgh", "ij", "", "ok"]);
  });
  it("returns one empty page for empty text", () => {
    expect(paginate("")).toEqual([""]);
  });
  it("splits lines into pages", () => {
    expect(paginate("a b c d e", 2, 1)).toEqual(["a\nb", "c\nd", "e"]);
  });
  it("ends a page before it passes the byte cap, so no text is cut off a page", () => {
    const text = Array.from({ length: 800 }, (_, i) => "价格按座位计算每年签约"[i % 11]).join("");
    const pages = paginate(text);
    for (const page of pages) {
      expect(new TextEncoder().encode(page).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(fitBytes(page)).toBe(page);
    }
    expect(pages.join("").replace(/\n/g, "")).toBe(text);
  });
  it("keeps six lines per page for plain text", () => {
    const pages = paginate(Array.from({ length: 12 }, (_, i) => `- point number ${i}`).join("\n"));
    expect(pages.map((p) => p.split("\n").length)).toEqual([6, 6]);
  });
  it("clips to a number of lines with an ellipsis", () => {
    expect(clip("one two three four five", 9, 2)).toBe("one two\nthree…");
  });
});

describe("fitBytes", () => {
  it("cuts on character boundaries", () => {
    const out = fitBytes("éééééé", 8);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(8);
  });
});

describe("formatAnswer", () => {
  it("hangs wrapped bullet lines under the text", () => {
    expect(wrap("• aaa bbb ccc", 9)).toEqual(["• aaa bbb", "   ccc"]);
  });
  it("turns dash bullets into dots", () => {
    expect(formatAnswer("- one\n- two")).toBe("• one\n• two");
  });
});

describe("screen", () => {
  it("shows the hint while listening", () => {
    const view = screen({ ...initialState(), mode: "listening" }, at);
    expect(view.status.content).toBe("LISTENING");
    expect(view.clock.content).toBe("13:05");
    expect(view.card.content).toContain("Listening for questions");
    expect(view.question.content).toBe("");
  });
  it("shows the question, the answer bright and the page count", () => {
    const answer = Array.from({ length: 12 }, (_, i) => `- point number ${i}`).join("\n");
    const view = screen({ ...initialState(), mode: "answer", question: "Why?", answer }, at);
    expect(view.question.content).toBe("“Why?”");
    expect(view.card.color).toBe(4);
    expect(view.status.content).toBe("ANSWER  ·  2 / 2");
    expect(view.card.content.startsWith("• point number 6")).toBe(true);
    expect(view.sigil).toBe("answer");
  });
  it("shows a caret while the answer streams", () => {
    const view = screen({ ...initialState(), mode: "answer", answer: "Yes" }, at);
    expect(view.card.content).toBe("Yes │");
  });
  it("dims an old answer", () => {
    const view = screen(
      { ...initialState(), mode: "answer", answer: "Yes.", answeredAt: at.getTime() - DIM_AFTER_MS - 1 },
      at,
    );
    expect(view.card.color).toBe(2);
  });
  it("shows a toast over the state", () => {
    const view = screen({ ...initialState(), mode: "listening", toast: { text: "SAVED  ·  Call", until: at.getTime() + 1 } }, at);
    expect(view.status.content).toBe("SAVED  ·  Call");
    expect(view.sigil).toBe("saved");
  });
});

describe("recall cue", () => {
  const t = at.getTime();
  const sarah = { name: "Sarah Chen", facts: ["12 Nov  ·  Pricing plan with Sarah", "Open: Send the deck", "Head of procurement, Northwind."] };
  const waiting = (arrivedAt = t): HudCue => ({ ...sarah, arrivedAt, shownAt: null, seen: false });
  /** Drawn and on the lens: the host accepted the upgrade at once. */
  const drawn = (shownAt = t, seen = false): HudCue => ({ ...sarah, arrivedAt: shownAt, shownAt, onLensAt: shownAt, seen });
  const st = (patch: Partial<HudState>): HudState => ({ ...initialState(), ...patch });

  it("writes the two lines of the Sarah cue", () => {
    const text = cueText(sarah);
    expect(text).toBe("SARAH CHEN  ·  12 Nov  ·  Pricing plan with Sarah\nOpen: Send the deck  ·  Head of procurement, Northwin…");
    const [one, two] = text.split("\n");
    expect(one).toHaveLength(49);
    expect(two).toHaveLength(54);
    expect(new TextEncoder().encode(text).length).toBe(109);
  });

  it("writes one line for a cue with one fact", () => {
    expect(cueText({ name: "Dana Scott", facts: ["1 Sep  ·  Lunch with Dana"] })).toBe("DANA SCOTT  ·  1 Sep  ·  Lunch with Dana");
  });

  it("keeps the worst case under the byte cap, so fitBytes leaves it alone", () => {
    const text = cueText({ name: "…".repeat(60), facts: ["“".repeat(80), "’".repeat(80), "…".repeat(80)] });
    expect(text.split("\n").map((l) => l.length)).toEqual([50, 54]);
    expect(fitBytes(text)).toBe(text);
  });

  it("finds room for a cue only where the question box is free", () => {
    const answered = (ago: number) => st({ mode: "answer", answer: "Yes.", answeredAt: t - ago });
    const table: [string, HudState, boolean, boolean][] = [
      ["listening", st({ mode: "listening" }), false, true],
      ["answer finished 31 s ago", answered(31_000), false, true],
      ["thinking", st({ mode: "thinking", question: "Why?" }), false, false],
      ["streaming", st({ mode: "answer", answer: "Yes", answeredAt: null }), false, false],
      ["answer finished 5 s ago", answered(5_000), false, false],
      ["paused", st({ mode: "paused" }), false, false],
      ["error", st({ mode: "error", error: "x" }), false, false],
      ["connecting", st({ mode: "connecting" }), false, false],
      ["thinking, cue drawn", st({ mode: "thinking", question: "Why?" }), true, true],
    ];
    for (const [name, state, isDrawn, room] of table) expect([name, cueRoom(state, t, isDrawn)]).toEqual([name, room]);
  });

  it("draws a waiting cue while listening", () => {
    const step = stepCue(st({ mode: "listening", cue: waiting() }), t);
    expect(step).toEqual({ cue: { ...waiting(), shownAt: t }, drawn: true, seen: false });
  });

  it("waits under a fresh answer and draws once it has dimmed", () => {
    const state = st({ mode: "answer", answer: "Yes.", answeredAt: t, cue: waiting() });
    expect(stepCue(state, t + 1000)).toEqual({ cue: waiting(), drawn: false, seen: false });
    const later = stepCue(state, t + DIM_AFTER_MS + 1);
    expect(later.drawn).toBe(true);
    expect(later.cue?.shownAt).toBe(t + DIM_AFTER_MS + 1);
  });

  it("keeps a waiting cue waiting in thinking, and a drawn cue drawn", () => {
    const thinking = { mode: "thinking" as const, question: "Why?" };
    expect(stepCue(st({ ...thinking, cue: waiting() }), t + 100)).toEqual({ cue: waiting(), drawn: false, seen: false });
    expect(stepCue(st({ ...thinking, cue: drawn() }), t + 100)).toEqual({ cue: drawn(), drawn: false, seen: false });
  });

  it("reports seen once at 3 s and drops the cue at 10 s", () => {
    let state = st({ mode: "listening", cue: drawn() });
    expect(stepCue(state, t + CUE_SEEN_MS - 1).seen).toBe(false);
    const step = stepCue(state, t + CUE_SEEN_MS);
    expect(step).toEqual({ cue: drawn(t, true), drawn: false, seen: true });
    state = { ...state, cue: step.cue };
    expect(stepCue(state, t + CUE_SEEN_MS + 500).seen).toBe(false);
    expect(stepCue(state, t + CUE_MS - 1).cue).not.toBeNull();
    expect(stepCue(state, t + CUE_MS)).toEqual({ cue: null, drawn: false, seen: false });
  });

  it("counts the 3 s and the 10 s from the accepted upgrade, and never reports a cue the host did not take", () => {
    const unconfirmed: HudCue = { ...sarah, arrivedAt: t, shownAt: t, seen: false };
    const state = st({ mode: "listening", cue: unconfirmed });
    expect(stepCue(state, t + CUE_SEEN_MS + 1000)).toEqual({ cue: unconfirmed, drawn: false, seen: false });
    expect(screen(state, new Date(t + 1000)).question.content).toBe(cueText(sarah));
    expect(stepCue(state, t + CUE_MS).cue).toBeNull();

    // Another text in the box, or no drawn cue: nothing changes.
    expect(confirmCue(unconfirmed, "“Why?”", t + 2000)).toBe(unconfirmed);
    expect(confirmCue(waiting(), cueText(sarah), t + 2000)).toEqual(waiting());
    const onLens = confirmCue(unconfirmed, cueText(sarah), t + 2000);
    expect(onLens).toEqual({ ...unconfirmed, onLensAt: t + 2000 });
    // Accepted once: a later accept of the same text does not restart the clock.
    expect(confirmCue(onLens, cueText(sarah), t + 2500)).toBe(onLens);
    const later = st({ mode: "listening", cue: onLens });
    expect(stepCue(later, t + 2000 + CUE_SEEN_MS - 1).seen).toBe(false);
    expect(stepCue(later, t + 2000 + CUE_SEEN_MS).seen).toBe(true);
    expect(stepCue(later, t + CUE_MS + 1000).cue).not.toBeNull();
    expect(screen(later, new Date(t + CUE_MS + 1000)).question.content).toBe(cueText(sarah));
    expect(stepCue(later, t + 2000 + CUE_MS).cue).toBeNull();
  });

  it("goes back to waiting when an answer starts before 3 s, and is dropped if it was already seen", () => {
    const streaming = { mode: "answer" as const, question: "Q?", answer: "Ye", answeredAt: null };
    expect(stepCue(st({ ...streaming, cue: drawn() }), t + 1000).cue).toEqual(waiting());
    expect(stepCue(st({ ...streaming, cue: drawn(t, true) }), t + 4000).cue).toBeNull();
  });

  it("drops a waiting cue after 60 s", () => {
    const state = st({ mode: "paused", cue: waiting() });
    expect(stepCue(state, t + CUE_WAIT_MS).cue).toEqual(waiting());
    expect(stepCue(state, t + CUE_WAIT_MS + 1).cue).toBeNull();
  });

  it("replaces a waiting cue and keeps a drawn cue of another name", () => {
    const mark = { name: "Mark Olsen", facts: ["Open: Call back"] };
    expect(acceptCue(null, sarah, t)).toEqual(waiting());
    expect(acceptCue(waiting(), mark, t + 5)).toEqual({ ...mark, arrivedAt: t + 5, shownAt: null, seen: false });
    expect(acceptCue(drawn(), mark, t + 5)).toEqual(drawn());
    expect(acceptCue(drawn(), sarah, t + 5)).toEqual(waiting(t + 5));
  });

  it("lets a new cue replace a drawn cue whose 10 s are over", () => {
    const mark = { name: "Mark Olsen", facts: ["Open: Call back"] };
    expect(acceptCue(drawn(), mark, t + CUE_MS - 1)).toEqual(drawn());
    expect(acceptCue(drawn(), mark, t + CUE_MS)).toEqual({ ...mark, arrivedAt: t + CUE_MS, shownAt: null, seen: false });
  });

  it("shows the cue in the question box at level 2 and leaves the rest of the screen alone", () => {
    for (const base of [st({ mode: "listening" }), st({ mode: "answer", question: "Why?", answer: "Yes.", answeredAt: t - 31_000 })]) {
      const plain = screen(base, at);
      const view = screen({ ...base, cue: drawn(t - 1000) }, at);
      expect(view.question).toEqual({ content: cueText(sarah), color: LIGHT.secondary });
      expect(view.status).toEqual(plain.status);
      expect(view.card).toEqual(plain.card);
      expect(view.clock).toEqual(plain.clock);
      expect(view.sigil).toBe(plain.sigil);
    }
  });

  it("does not show a waiting cue, an expired cue or a cue without room", () => {
    expect(screen(st({ mode: "listening", cue: waiting() }), at).question.content).toBe("");
    expect(screen(st({ mode: "listening", cue: drawn(t - CUE_MS) }), at).question.content).toBe("");
    const fresh = st({ mode: "answer", question: "Why?", answer: "Yes.", answeredAt: t - 5000, cue: drawn() });
    expect(screen(fresh, at).question.content).toBe("“Why?”");
  });
});
