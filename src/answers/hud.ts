/**
 * Phosphor: the HUD's design language. See DESIGN.md.
 *
 * The G2 draws green light on a clear lens: 576 x 288 per eye, one
 * proportional font, 5 text brightness levels (0-4), 16 grey levels in images.
 * Measured in the simulator: about 9 px per character and 29 px per line.
 * Glyphs that render: • · › » ● ○ ─ │ ▶ ■ … ♪ ← → and curly quotes.
 * Glyphs that do NOT render: ◦ ▸ ⏸ ✓ ✗ ⋯. Re-check on real glasses.
 */
import type { Box } from "../core/box";
import { MAX_TEXT_BYTES, clockText, ellipsis } from "../core/text";
import type { SigilMode } from "./sigil";

export { fitBytes } from "../core/text";

/** Measured: about 8.4 px per character in the 558 px inside the card. Kept a little short for wide letters. */
export const CARD_CHARS = 60;
export const CARD_LINES = 6;
export const QUESTION_CHARS = 54;

/** Light levels (text brightness). Brighter means nearer and more important. */
export const LIGHT = { primary: 4, near: 3, secondary: 2, ambient: 1 } as const;

/** A finished answer steps back in light so it stops pulling the eye. */
export const FADE_STEPS = [
  { afterMs: 20_000, light: LIGHT.near },
  { afterMs: 30_000, light: LIGHT.secondary },
] as const;
export const DIM_AFTER_MS = 30_000;
/** Vault recall cue: on the lens for 10 s; acknowledged after 3 s on the lens; dropped if it waits 60 s for room. */
export const CUE_MS = 10_000;
export const CUE_SEEN_MS = 3_000;
export const CUE_WAIT_MS = 60_000;
/** Line 1 of the cue starts with a name in capitals, which is wider than mixed case. */
export const CUE_CHARS = 50;
/** Shown after streaming text while the answer is still arriving. */
export const CARET = " │";

// 8 px grid. The Sigil owns the top-left corner; everything else aligns to x = 76.
export const SIGIL: Box = { id: 5, name: "sigil", x: 4, y: 4, width: 64, height: 64 };
// Header boxes use no padding and a full 29 px line each, or the firmware draws a scroll bar.
export const STATUS: Box = { id: 1, name: "status", x: 76, y: 4, width: 430, height: 30 };
export const CLOCK: Box = { id: 2, name: "clock", x: 528, y: 4, width: 48, height: 30 };
export const QUESTION: Box = { id: 3, name: "question", x: 76, y: 32, width: 500, height: 60 };
export const CARD: Box = { id: 4, name: "card", x: 0, y: 94, width: 576, height: 194 };


export type HudMode = "connecting" | "listening" | "paused" | "thinking" | "answer" | "error";

/**
 * A recall cue from the server. `shownAt` is null while it waits for room on the lens.
 * `onLensAt` is set when the host accepted the upgrade that draws it; until then it does not count as seen.
 */
export type HudCue = { name: string; facts: string[]; arrivedAt: number; shownAt: number | null; onLensAt?: number; seen: boolean };

/** The 10 s on the lens count from the accepted upgrade, or from the draw while none was accepted yet. */
const cueStart = (cue: HudCue): number => cue.onLensAt ?? cue.shownAt ?? cue.arrivedAt;

export type HudState = {
  mode: HudMode;
  question: string;
  answer: string;
  page: number;
  /** While true, the newest page is shown as the answer streams in. */
  follow: boolean;
  answeredAt: number | null;
  error: string;
  toast: { text: string; until: number } | null;
  cue: HudCue | null;
};

export const initialState = (): HudState => ({
  mode: "connecting",
  question: "",
  answer: "",
  page: 0,
  follow: true,
  answeredAt: null,
  error: "",
  toast: null,
  cue: null,
});

export type Cell = { content: string; color: number };
export type Screen = {
  sigil: SigilMode;
  status: Cell;
  clock: Cell;
  question: Cell;
  card: Cell;
  page: number;
  pageCount: number;
};

/** Word-wraps text into display lines; keeps blank lines between paragraphs. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    // Wrapped lines of a "• " bullet hang under its text.
    const indent = paragraph.startsWith("• ") ? "   " : "";
    let line = "";
    const flush = (): void => {
      lines.push(line);
      line = indent;
    };
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > width - indent.length) {
        if (line.trim()) flush();
        lines.push(line + rest.slice(0, width - indent.length));
        line = indent;
        rest = rest.slice(width - indent.length);
      }
      if (!line.trim()) line = line + rest;
      else if (line.length + 1 + rest.length <= width) line += " " + rest;
      else {
        flush();
        line += rest;
      }
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const encoder = new TextEncoder();

/**
 * Splits text into screen-sized pages. Always returns at least one page.
 * A page also ends before it passes maxBytes, so the byte cap of the text container never cuts text off a page.
 */
export function paginate(text: string, linesPerPage = CARD_LINES, width = CARD_CHARS, maxBytes = MAX_TEXT_BYTES): string[] {
  const pages: string[] = [];
  let page: string[] = [];
  let bytes = 0;
  for (const line of wrap(text, width)) {
    // The line plus its "\n" separator.
    const size = encoder.encode(line).length + 1;
    if (page.length === linesPerPage || (page.length > 0 && bytes + size - 1 > maxBytes)) {
      pages.push(page.join("\n"));
      page = [];
      bytes = 0;
    }
    page.push(line);
    bytes += size;
  }
  if (page.length > 0) pages.push(page.join("\n"));
  return pages.length > 0 ? pages : [""];
}

/** Markdown-style "- " bullets become "• ", which the glasses font draws. */
export function formatAnswer(text: string): string {
  return text.replace(/^[ \t]*[-*][ \t]+/gm, "• ").trim();
}

/** At most `lines` wrapped lines, with "…" when cut. */
export function clip(text: string, width: number, lines: number): string {
  const all = wrap(text, width);
  if (all.length <= lines) return all.join("\n");
  const kept = all.slice(0, lines);
  kept[lines - 1] = (kept[lines - 1] ?? "").slice(0, width - 1) + "…";
  return kept.join("\n");
}


const HINT = ["Listening for questions…", "", "", "", "TAP  pause    ·    DOUBLE TAP  clear    ·    HOLD  save"].join("\n");

export function answerLight(answeredAt: number | null, now: number): number {
  if (answeredAt === null) return LIGHT.primary;
  let light: number = LIGHT.primary;
  for (const step of FADE_STEPS) if (now - answeredAt > step.afterMs) light = step.light;
  return light;
}

/** The two cue lines: "NAME  ·  fact 1", then "fact 2  ·  fact 3". */
export function cueText(cue: { name: string; facts: string[] }): string {
  const first = ellipsis(`${cue.name.toUpperCase()}  ·  ${cue.facts[0] ?? ""}`, CUE_CHARS);
  const second = ellipsis(cue.facts.slice(1, 3).join("  ·  "), QUESTION_CHARS);
  return second ? `${first}\n${second}` : first;
}

/**
 * True when the QUESTION box is free for a cue: while listening, or under an answer that has dimmed.
 * In thinking, only a cue already drawn keeps the box; a waiting cue never covers the quoted question.
 */
export function cueRoom(state: HudState, now: number, drawn: boolean): boolean {
  if (state.mode === "listening") return true;
  if (state.mode === "answer") return state.answeredAt !== null && now - state.answeredAt > DIM_AFTER_MS;
  if (state.mode === "thinking") return drawn;
  return false;
}

/** A new cue replaces a waiting cue, an expired cue or a cue for the same name. A drawn cue for another name keeps the box. */
export function acceptCue(current: HudCue | null, message: { name: string; facts: string[] }, now: number): HudCue {
  if (current && current.shownAt !== null && current.name !== message.name && now - cueStart(current) < CUE_MS) return current;
  return { name: message.name, facts: [...message.facts], arrivedAt: now, shownAt: null, seen: false };
}

/**
 * Moves the cue one step: draw it when there is room, report `seen` once after CUE_SEEN_MS on the lens
 * (counted from the accepted upgrade), drop it after CUE_MS. `drawn` is true only on the step that put it on the screen.
 */
export function stepCue(state: HudState, now: number): { cue: HudCue | null; drawn: boolean; seen: boolean } {
  const cue = state.cue;
  const none = { drawn: false, seen: false };
  if (!cue) return { cue: null, ...none };
  if (cue.shownAt === null) {
    if (now - cue.arrivedAt > CUE_WAIT_MS) return { cue: null, ...none };
    if (cueRoom(state, now, false)) return { cue: { ...cue, shownAt: now }, drawn: true, seen: false };
    return { cue, ...none };
  }
  if (now - cueStart(cue) >= CUE_MS) return { cue: null, ...none };
  if (!cueRoom(state, now, true)) return { cue: cue.seen ? null : { ...cue, shownAt: null, onLensAt: undefined }, ...none };
  if (!cue.seen && cue.onLensAt !== undefined && now - cue.onLensAt >= CUE_SEEN_MS) return { cue: { ...cue, seen: true }, drawn: false, seen: true };
  return { cue, ...none };
}

/** The host accepted `content` for the QUESTION box: when that is the drawn cue, it is now on the lens. Else the cue is unchanged. */
export function confirmCue(cue: HudCue | null, content: string, now: number): HudCue | null {
  if (!cue || cue.shownAt === null || cue.onLensAt !== undefined || content !== cueText(cue)) return cue;
  return { ...cue, onLensAt: now };
}

export function screen(state: HudState, now: Date): Screen {
  const streaming = state.mode === "answer" && state.answeredAt === null;
  const pages = paginate(formatAnswer(state.answer) + (streaming ? CARET : ""));
  const page = Math.min(Math.max(state.follow ? pages.length - 1 : state.page, 0), pages.length - 1);
  const position = pages.length > 1 ? `  ·  ${page + 1} / ${pages.length}` : "";
  const toastOn = state.toast !== null && state.toast.until > now.getTime();

  let status: string;
  if (toastOn && state.toast) status = state.toast.text;
  else if (state.mode === "connecting") status = "CONNECTING";
  else if (state.mode === "paused") status = "PAUSED";
  else if (state.mode === "thinking") status = "THINKING";
  else if (state.mode === "error") status = "CHECK SETUP";
  else if (state.mode === "answer") status = "ANSWER" + position;
  else status = "LISTENING";

  let card: Cell;
  if (state.mode === "error") card = { content: clip(state.error, CARD_CHARS, CARD_LINES), color: LIGHT.near };
  else if (state.answer) card = { content: pages[page] ?? "", color: answerLight(state.answeredAt, now.getTime()) };
  else if (state.mode === "paused") card = { content: "Not listening.\n\nTap to listen again.", color: LIGHT.secondary };
  else if (state.mode === "thinking") card = { content: "", color: LIGHT.ambient };
  else card = { content: HINT, color: LIGHT.ambient };

  const cueOn =
    state.cue !== null && state.cue.shownAt !== null && now.getTime() - cueStart(state.cue) < CUE_MS && cueRoom(state, now.getTime(), true);

  const sigil: SigilMode = toastOn && state.toast?.text.startsWith("SAVED") ? "saved" : state.mode === "answer" ? "answer" : state.mode;

  return {
    sigil,
    status: { content: status, color: LIGHT.secondary },
    clock: { content: clockText(now), color: LIGHT.ambient },
    question: {
      content:
        cueOn && state.cue
          ? cueText(state.cue)
          : (state.answer || state.mode === "thinking") && state.question
            ? clip(`“${state.question}”`, QUESTION_CHARS, 2)
            : "",
      color: LIGHT.secondary,
    },
    card,
    page,
    pageCount: pages.length,
  };
}
