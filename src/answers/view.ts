import { LIGHT, bodyContent, bodyLinesFor, type Cell } from "../core/hud";
import { clipPx, clockText, fitPx, paginatePx } from "../core/text";
import { iconFrame, type IconMode } from "./header";
import { RIBBON_COLUMNS, type LensModel, type RecallDraw, type SourcesDraw } from "./lens";
import { findNode, linkedNodes, sourceNodes, type Vault } from "./vault";

/** Answers: the state of the page, and the pure function that turns it into what the lens shows. */

/** Shown after streaming text while the answer is still arriving. */
export const CARET = " │";

/** Markdown-style "- " bullets become "• ", which the glasses font draws. */
export function formatAnswer(text: string): string {
  return text.replace(/^[ \t]*[-*][ \t]+/gm, "• ").trim();
}

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

/** The hint under a listening lens, at (0, 255). */
export const HINT = "Tap pause  ·  Double tap clear  ·  Hold save";
/**
 * Where an answer wraps. Beside the source orb it wraps at 320 px: that is the width at which the board's own
 * sample breaks where the board breaks it by hand. Without sources it uses the whole lens.
 */
export const BODY_WIDE = 576;
export const BODY_NARROW = 320;
/** The question may run 440 px when the orb sits at the right. */
export const QUESTION_NARROW = 440;
/** An answer page holds 7 lines, so it fits with a one-line and a two-line question alike. */
export const ANSWER_LINES = 7;
/** A text line of the recall card: 272 px (from x 304 to the lens edge). */
export const CARD_WIDTH = 272;
/** The most page squares drawn. */
const MAX_SQUARES = 6;

export type HudMode = "connecting" | "listening" | "paused" | "thinking" | "answer" | "error";

/** The card of a recall cue: every part is optional. */
export type RecallCard = { lead?: string; met?: number; seen?: string; last?: string; open?: string };

/**
 * A recall cue from the server. `shownAt` is null while it waits for room on the lens.
 * `onLensAt` is set when the host accepted the upgrade that draws it; until then it does not count as seen.
 */
export type HudCue = {
  name: string;
  facts: string[];
  id?: number;
  card?: RecallCard;
  arrivedAt: number;
  shownAt: number | null;
  onLensAt?: number;
  seen: boolean;
};

/** The 10 s on the lens count from the accepted upgrade, or from the draw while none was accepted yet. */
const cueStart = (cue: HudCue): number => cue.onLensAt ?? cue.shownAt ?? cue.arrivedAt;

export type HudState = {
  mode: HudMode;
  question: string;
  answer: string;
  /** Titles of the notes the answer came from. */
  notes: string[];
  page: number;
  /** While true, the newest page is shown as the answer streams in. */
  follow: boolean;
  answeredAt: number | null;
  error: string;
  toast: { text: string; until: number } | null;
  cue: HudCue | null;
  vault: Vault | null;
};

export const initialState = (): HudState => ({
  mode: "connecting",
  question: "",
  answer: "",
  notes: [],
  page: 0,
  follow: true,
  answeredAt: null,
  error: "",
  toast: null,
  cue: null,
  vault: null,
});

/** The four text lines of the recall card, at (304, 82), (304, 109), (304, 154) and (304, 198): "" when the part is absent. */
export function cardLines(cue: { facts: string[]; card?: RecallCard }): [string, string, string, string] {
  const card = cue.card;
  const has = card !== undefined && (card.lead !== undefined || card.met !== undefined || card.last !== undefined || card.open !== undefined);
  if (!has) {
    // A server without the card: the facts it did send, one to a line.
    return [fitPx(cue.facts[0] ?? "", CARD_WIDTH), fitPx(cue.facts[1] ?? "", CARD_WIDTH), "", ""];
  }
  const lead = card.lead ?? "";
  const comma = lead.indexOf(",");
  const first = (comma < 0 ? lead : lead.slice(0, comma)).trim();
  const rest = comma < 0 ? "" : lead.slice(comma + 1).trim();
  const met = card.met !== undefined ? `met ${card.met} ${card.met === 1 ? "time" : "times"}` : "";
  const second = [rest, met].filter((part) => part !== "").join("  ·  ");
  return [fitPx(first, CARD_WIDTH), fitPx(second, CARD_WIDTH), fitPx(card.last ?? "", CARD_WIDTH), fitPx(card.open ?? "", CARD_WIDTH)];
}

/** The text that proves the recall view is on the lens: the first card line that has text. */
export const cardProof = (cue: { facts: string[]; card?: RecallCard }): string => cardLines(cue).find((line) => line !== "") ?? "";

/** The recall view's data for a cue, or null without a graph or without a node for that person. */
export function recallFor(state: HudState, entrance = 1): RecallDraw | null {
  const cue = state.cue;
  if (!cue || !state.vault) return null;
  const focus = findNode(state.vault, cue.name, cue.id);
  if (focus === null) return null;
  const lines = cardLines(cue);
  return {
    vault: state.vault,
    focus,
    linked: linkedNodes(state.vault, focus, 3),
    name: cue.name,
    seen: cue.card?.seen ? cue.card.seen : null,
    hasLast: lines[2] !== "",
    hasOpen: lines[3] !== "",
    entrance,
  };
}

/** The source orb for an answer, or null without notes, a graph, or a note that the graph has. */
export function sourcesFor(state: HudState): SourcesDraw | null {
  if (state.mode !== "answer" || !state.vault || state.notes.length === 0) return null;
  const lit = sourceNodes(state.vault, state.notes);
  return lit.length > 0 ? { vault: state.vault, lit, count: state.notes.length, titles: state.notes.slice(0, 3) } : null;
}

/** Everything that changes with the clock and the microphone, not with the state. The demo fills it with the board's own values. */
export type Env = {
  /** Seconds: the lens's own clock (the graph turns by it, the icon breathes by it). */
  t: number;
  clock: string;
  /** The five meter levels, 0 to 1. */
  meter: readonly number[];
  /** The ribbon's 73 column heights. */
  columns: readonly number[];
  /** Progress of the opening, or null when it is not on. */
  open: number | null;
  /** The recall entrance, 0 to 1. */
  entrance: number;
  /** Seconds in the icon's current state, and the voice level for the icon. */
  since: number;
  level: number;
};

export const idleEnv = (now: Date): Env => ({
  t: 0,
  clock: clockText(now),
  meter: [0, 0, 0, 0, 0],
  columns: new Array<number>(RIBBON_COLUMNS).fill(0),
  open: null,
  entrance: 1,
  since: 0,
  level: 0,
});

export type Screen = {
  lens: LensModel;
  icon: IconMode;
  /** The glasses text: status (32, 0), question (0, 36), body (0, 72), hint (0, 255), and the card's four lines. */
  status: Cell;
  question: Cell;
  body: Cell;
  hint: Cell;
  card: [Cell, Cell, Cell, Cell];
  page: number;
  pageCount: number;
  recall: RecallDraw | null;
};

export const answerLight = (answeredAt: number | null, now: number): number => {
  if (answeredAt === null) return LIGHT.primary;
  let light: number = LIGHT.primary;
  for (const step of FADE_STEPS) if (now - answeredAt > step.afterMs) light = step.light;
  return light;
};

/** The two compact cue lines: "NAME  ·  line 1", then "line 2". Without a card, the facts as before: the first, then the next two. */
export function cueText(cue: { name: string; facts: string[]; card?: RecallCard }): string {
  const hasCard = cardLines({ facts: [], card: cue.card }).some((line) => line !== "");
  const [one, two] = hasCard ? cardLines(cue) : [cue.facts[0] ?? "", cue.facts.slice(1, 3).join("  ·  ")];
  const first = fitPx(`${cue.name.toUpperCase()}  ·  ${one}`, 576);
  const second = fitPx(two, 576);
  return second ? `${first}\n${second}` : first;
}

/**
 * True when the cue may be drawn: while listening, or under an answer that has dimmed.
 * In thinking, only a cue already drawn keeps its place; a waiting cue never covers the quoted question.
 */
export function cueRoom(state: HudState, now: number, drawn: boolean): boolean {
  if (state.mode === "listening") return true;
  if (state.mode === "answer") return state.answeredAt !== null && now - state.answeredAt > DIM_AFTER_MS;
  if (state.mode === "thinking") return drawn;
  return false;
}

/** A new cue replaces a waiting cue, an expired cue or a cue for the same name. A drawn cue for another name keeps the place. */
export function acceptCue(current: HudCue | null, message: { name: string; facts: string[]; id?: number; card?: RecallCard }, now: number): HudCue {
  if (current && current.shownAt !== null && current.name !== message.name && now - cueStart(current) < CUE_MS) return current;
  return { name: message.name, facts: [...message.facts], id: message.id, card: message.card, arrivedAt: now, shownAt: null, seen: false };
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

/** The host accepted `content` for the question or the card's first line: when that is the drawn cue, it is now on the lens. Else the cue is unchanged. */
export function confirmCue(cue: HudCue | null, content: string, now: number): HudCue | null {
  if (!cue || cue.shownAt === null || cue.onLensAt !== undefined) return cue;
  if (content !== cueText(cue) && content !== cardProof(cue)) return cue;
  return { ...cue, onLensAt: now };
}

export function screen(state: HudState, now: Date, env: Env = idleEnv(now)): Screen {
  const at = now.getTime();
  const streaming = state.mode === "answer" && state.answeredAt === null;
  const sources = sourcesFor(state);
  const answerPages = paginatePx(formatAnswer(state.answer) + (streaming ? CARET : ""), ANSWER_LINES, sources ? BODY_NARROW : BODY_WIDE);
  const page = Math.min(Math.max(state.follow ? answerPages.length - 1 : state.page, 0), answerPages.length - 1);
  const toastOn = state.toast !== null && state.toast.until > at;

  const cueOn = state.cue !== null && state.cue.shownAt !== null && at - cueStart(state.cue) < CUE_MS && cueRoom(state, at, true);
  const recall = cueOn && state.mode === "listening" ? recallFor(state, env.entrance) : null;

  let status: string;
  if (toastOn && state.toast) status = state.toast.text;
  else if (recall) status = "Recall";
  else if (state.mode === "connecting") status = "Connecting";
  else if (state.mode === "paused") status = "Paused";
  else if (state.mode === "thinking") status = "Thinking";
  else if (state.mode === "error") status = "Check setup";
  else if (state.mode === "answer") status = "Answer";
  else status = "Listening";

  // The question place: the compact cue takes it; else the quoted question.
  let question: Cell;
  if (cueOn && state.cue && !recall) question = { content: cueText(state.cue), color: LIGHT.secondary };
  else if ((state.answer || state.mode === "thinking") && state.question) {
    question = { content: clipPx(`“${state.question}”`, sources ? QUESTION_NARROW : 576, 2), color: LIGHT.secondary };
  } else question = { content: "", color: LIGHT.secondary };

  const lines = bodyLinesFor(question.content);
  let body: Cell;
  if (state.mode === "error") body = { content: bodyContent(question.content, clipPx(state.error, 576, lines)), color: LIGHT.near };
  else if (state.answer) body = { content: bodyContent(question.content, answerPages[page] ?? ""), color: answerLight(state.answeredAt, at) };
  else if (state.mode === "paused") body = { content: bodyContent(question.content, "Not listening.\n\nTap to listen again."), color: LIGHT.secondary };
  else body = { content: "", color: LIGHT.ambient };

  const listeningLens = state.mode === "listening" && !recall;
  const hint: Cell = { content: listeningLens ? HINT : "", color: LIGHT.ambient };

  const rows = recall && state.cue ? cardLines(state.cue) : (["", "", "", ""] as const);
  const card: [Cell, Cell, Cell, Cell] = [
    { content: rows[0], color: LIGHT.near },
    { content: rows[1], color: LIGHT.secondary },
    { content: rows[2], color: LIGHT.near },
    { content: rows[3], color: LIGHT.near },
  ];

  const saved = toastOn && state.toast?.text.startsWith("Saved");
  const icon: IconMode = saved ? "saved" : recall ? "answer" : state.mode;
  const hearing = state.mode === "listening" || state.mode === "answer" || state.mode === "thinking";

  const view: LensModel["view"] = recall ? "recall" : state.mode === "answer" ? "answer" : state.mode === "listening" || state.mode === "paused" ? "listening" : "plain";
  const lens: LensModel = {
    clock: env.clock,
    icon: iconFrame(icon, env.t, env.since, env.level),
    meter: hearing ? env.meter : null,
    view,
    ribbon: listeningLens ? { columns: env.columns, dim: false } : state.mode === "paused" ? { columns: env.columns, dim: true } : null,
    open: env.open !== null && listeningLens ? { r: env.open, vault: state.vault } : null,
    recall,
    sources,
    pages: state.mode === "answer" && answerPages.length > 1 ? { count: Math.min(MAX_SQUARES, answerPages.length), current: Math.min(MAX_SQUARES - 1, page) } : null,
  };

  return {
    lens,
    icon,
    status: { content: status, color: LIGHT.near },
    question,
    body,
    hint,
    card,
    page,
    pageCount: answerPages.length,
    recall,
  };
}

/** The opening ("the vault comes online") lasts 3 s by the clock. */
export const OPEN_MS = 3000;

/** True in the plain listening state: nothing on the body, no cue, no answer, no error. A toast is fine. */
export const plainListening = (state: HudState): boolean => state.mode === "listening" && state.answer === "" && state.cue === null;

/**
 * Progress of the opening from 0 to 1, or null when it is not on: it was never started, it has ended,
 * or the state is not plain listening. `frozen` (the `load` parameter) holds it at one progress.
 */
export function openRatio(state: HudState, startedAt: number | null, now: number, frozen: number | null): number | null {
  if (!plainListening(state)) return null;
  if (frozen !== null) return Math.max(0, Math.min(1, frozen));
  if (startedAt === null) return null;
  const r = (now - startedAt) / OPEN_MS;
  return r >= 0 && r < 1 ? r : null;
}
