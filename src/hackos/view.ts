import { plain } from "../code/view";
// One hold limit and one set of notes for both apps.
export { HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS } from "../code/view";
import type { Box } from "../core/box";
import { LIGHT, type Cell } from "../core/hud";
import { GLYPHS } from "../core/font5x7";
import type { HackView } from "../core/protocol";
import { LINE, clipPx, paginatePx } from "../core/text";

/**
 * What the core and the header icon show. `off` is connecting, setup and error:
 * dim, with a broken core and no bar in the icon.
 */
export type HackMode = "off" | "idle" | "recording" | "working" | "waking" | "answering";

/**
 * The board's two layouts. `waking`: the core on the left, the counter on the right. `answer`: the answer on
 * the left, the core on the right. Every state that is not waking uses `answer`.
 */
export type HackLayout = "waking" | "answer";

/** The text containers of the page, at the board's places. The picture (header, core, counter, bars, footer) is one raster. */
export const STATUS_BOX: Box = { id: 5, name: "status", x: 32, y: 0, width: 340, height: LINE };
export const PROMPT_BOX: Box = { id: 6, name: "prompt", x: 0, y: 36, width: 576, height: LINE };
export const BODY_LINES = 7;
export const BODY_BOX: Box = { id: 7, name: "body", x: 0, y: 72, width: 576, height: BODY_LINES * LINE };
export const SENTENCE_BOX: Box = { id: 8, name: "sentence", x: 222, y: 176, width: 354, height: LINE };
export const HINT_BOX: Box = { id: 9, name: "hint", x: 0, y: 255, width: 576, height: LINE };
export const TEXT_BOXES: Box[] = [STATUS_BOX, PROMPT_BOX, BODY_BOX, SENTENCE_BOX, HINT_BOX];

export type HackScreen = {
  mode: HackMode;
  layout: HackLayout;
  status: Cell;
  prompt: Cell;
  body: Cell;
  /** The line under the counter while the GPU wakes. */
  sentence: Cell;
  hint: Cell;
  /** Micro caps at the foot of the lens (the raster), or "". */
  footer: string;
  /** "38 TOK/S", or null when the server sent no samples. */
  speed: string | null;
  /** Heights, 2 to 11, of the speed bars, or null. */
  bars: number[] | null;
  /** Whole seconds since the GPU started to wake (the counter). */
  seconds: number;
  page: number;
  pageCount: number;
};

/** The body wraps here in every state, so text never runs under the core (its left edge is near x 424). */
export const BODY_WRAP = 400;
/** Shown at the end of a streaming answer. */
const CARET = " │";
export const HINT = "Hold talk  ·  Double tap new chat";
export const WAKING_SENTENCE = "The first answer takes about a minute.";

/** True when the 5 x 7 font has every character of `text`, so the raster shows exactly this text (never a "?" or a gap). */
export const microFits = (text: string): boolean => [...text].every((ch) => GLYPHS[ch.toUpperCase()] !== undefined && ch !== "?");

/** The footer: the parts the font can show, whole or not at all; a part with an unknown character is left out, never changed. */
export const footerOf = (...parts: string[]): string => parts.filter((p) => p !== "" && microFits(p)).join("  ·  ");

/** The speed bars (heights 2 to 11, as the board's) and the "TOK/S" text, from tokens-per-second samples. */
export function speedOf(rate: readonly number[] | undefined): { bars: number[]; speed: string } | null {
  if (!rate || rate.length === 0) return null;
  const peak = Math.max(...rate);
  const mean = rate.reduce((sum, r) => sum + r, 0) / rate.length;
  if (!(mean > 0)) return null;
  return { bars: rate.map((r) => 2 + Math.round(peak > 0 ? (9 * r) / peak : 0)), speed: `${Math.round(mean)} TOK/S` };
}

/** States in which a double tap stops the answer, or drops the speech that is being transcribed. */
const STOPPABLE = new Set<HackView["state"]>(["transcribing", "waking", "thinking", "answering"]);
/**
 * After an answer ends, the lens can still show it streaming for a moment. A double tap
 * in that time is meant as "stop", so it does not start a new chat.
 */
export const NEW_CHAT_GRACE_MS = 1500;

export const stoppable = (view: HackView | null): boolean => !!view && STOPPABLE.has(view.state);

/** What a double tap sends: stop, a new chat, or nothing (just after an answer ended). */
export function doubleTapAction(view: HackView | null, endedAt: number, now: number): "hack_stop" | "hack_new" | null {
  if (!view) return null;
  if (stoppable(view)) return "hack_stop";
  return now - endedAt >= NEW_CHAT_GRACE_MS ? "hack_new" : null;
}

const seconds = (view: HackView, now: Date) => (view.startedAt ? Math.max(0, Math.floor((now.getTime() - view.startedAt) / 1000)) : 0);

/**
 * The glasses screen for a HackOS view. While an answer streams in, the newest page shows; `page` picks a page of
 * a finished answer. `notice` is a note from this page itself (no pairing key, a microphone that did not open).
 */
export function hackScreen(view: HackView | null, page: number, now: Date, notice = ""): HackScreen {
  const cell = (content: string, color: number): Cell => ({ content, color });
  const none = cell("", LIGHT.ambient);
  const quote = (p: string): Cell => cell(p ? clipPx(`“${p}”`, PROMPT_BOX.width, 1) : "", LIGHT.secondary);
  const note = (text: string): Cell => cell(clipPx(text, PROMPT_BOX.width, 1), LIGHT.near);
  const lines = (text: string, color: number, count = BODY_LINES): Cell => cell(clipPx(text, BODY_WRAP, count), color);
  const hint = cell(HINT, LIGHT.ambient);
  const make = (mode: HackMode, status: string, parts: Partial<HackScreen> = {}): HackScreen => ({
    mode, layout: "answer", status: cell(status, LIGHT.near), prompt: none, body: none, sentence: none, hint: none,
    footer: "", speed: null, bars: null, seconds: 0, page: 0, pageCount: 1, ...parts,
  });

  if (!view) {
    if (notice) return make("off", "Check", { body: lines(notice, LIGHT.near) });
    return make("off", "Connecting", { hint });
  }
  const footer = footerOf(view.model);
  const prompt = notice ? note(notice) : quote(view.prompt);
  switch (view.state) {
    case "off":
      return make("off", "HackOS  ·  setup", { prompt, body: lines(view.error, LIGHT.near), footer });
    case "recording":
      return make("recording", "Listening  ·  release to send", { prompt: notice ? prompt : none, body: cell("Speak…", LIGHT.secondary), footer });
    case "transcribing":
      return make("working", "Transcribing", { prompt: notice ? prompt : none, footer });
    case "waking":
      return make("waking", "Waking the GPU", { layout: "waking", prompt, sentence: cell(WAKING_SENTENCE, LIGHT.secondary), seconds: seconds(view, now), footer });
    case "thinking":
      return make("working", `Thinking  ·  ${seconds(view, now)}s`, { prompt, footer });
    case "error":
      return make("off", "Check", { prompt, body: lines(view.error || "Something went wrong.", LIGHT.near), footer });
    case "answering": {
      const pages = paginatePx(plain(view.answer) + CARET, BODY_LINES, BODY_WRAP);
      const p = pages.length - 1;
      const status = `HackOS${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      return make("answering", status, { prompt, body: cell(pages[p] ?? "", LIGHT.primary), footer, ...speedOf(view.rate), page: p, pageCount: pages.length });
    }
    case "done":
    case "idle": {
      const answer = view.answer ? plain(view.answer) : "";
      // A note from a failed recording ("Didn't catch that"), or from this page.
      const message = notice || view.error;
      if (!answer) return make("idle", "HackOS", { prompt: quote(view.prompt), body: message ? lines(message, LIGHT.near, BODY_LINES - 1) : none, hint });
      // The note takes the prompt's place, so it shows on every page of the old answer.
      const shown = message ? note(message) : quote(view.prompt);
      const pages = paginatePx(answer, BODY_LINES, BODY_WRAP);
      const p = Math.min(Math.max(page, 0), pages.length - 1);
      const status = `HackOS${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      const foot = footerOf(view.stats, view.model);
      return make("idle", status, { prompt: shown, body: cell(pages[p] ?? "", LIGHT.primary), footer: foot, ...speedOf(view.rate), page: p, pageCount: pages.length });
    }
  }
}

/** The opening shows only the header's label and the hint (the board's `boot` screen). */
export function bootScreen(s: HackScreen): HackScreen {
  return { ...s, status: { content: "HackOS", color: LIGHT.near }, prompt: { content: "", color: LIGHT.ambient }, body: { content: "", color: LIGHT.ambient }, sentence: { content: "", color: LIGHT.ambient }, hint: { content: HINT, color: LIGHT.ambient }, footer: "", speed: null, bars: null };
}

/** The glasses text of a screen, line by line, at the place each container puts it. For tests and checks. */
export function screenTexts(s: HackScreen): { text: string; x: number; y: number; level: number }[] {
  const cells: [Box, Cell][] = [[STATUS_BOX, s.status], [PROMPT_BOX, s.prompt], [BODY_BOX, s.body], [SENTENCE_BOX, s.sentence], [HINT_BOX, s.hint]];
  return cells.flatMap(([box, c]) => c.content.split("\n").flatMap((text, i) => (text === "" ? [] : [{ text, x: box.x, y: box.y + i * LINE, level: c.color }])));
}
