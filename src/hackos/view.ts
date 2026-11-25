import { CARD_CHARS, CARD_LINES, CARET, LIGHT, QUESTION_CHARS, clip, paginate, type Cell } from "../answers/hud";
import type { SigilMode } from "../answers/sigil";
import { plain } from "../code/view";
// One hold limit and one set of notes for both apps.
export { HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS } from "../code/view";
import type { HackView } from "../core/protocol";
import { clockText } from "../core/text";

export type HackScreen = { sigil: SigilMode; status: Cell; clock: Cell; question: Cell; card: Cell; page: number; pageCount: number };

const HINT = ["Hold and speak.", "", "", "", "HOLD  talk    ·    DOUBLE TAP  new chat"].join("\n");

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

const seconds = (view: HackView, now: Date) => (view.startedAt ? Math.max(0, Math.round((now.getTime() - view.startedAt) / 1000)) : 0);

/**
 * The glasses screen for a HackOS view. While an answer streams in, the newest
 * page shows; `page` picks a page of a finished answer. `notice` is a note from this
 * page itself (no pairing key, a microphone that did not open); it takes the prompt's line.
 */
export function hackScreen(view: HackView | null, page: number, now: Date, notice = ""): HackScreen {
  const clock = { content: clockText(now), color: LIGHT.ambient };
  const prompt = (p: string): Cell => ({ content: p ? clip(`“${p}”`, QUESTION_CHARS, 2) : "", color: LIGHT.secondary });
  const note = (text: string): Cell => ({ content: clip(text, QUESTION_CHARS, 2), color: LIGHT.near });
  const base = (sigil: SigilMode, status: string, card: Cell, question: Cell = notice ? note(notice) : prompt(view?.prompt ?? "")): HackScreen => ({
    sigil,
    status: { content: status, color: LIGHT.secondary },
    clock,
    question,
    card,
    page: 0,
    pageCount: 1,
  });
  if (!view) {
    if (notice) return base("error", "CHECK", { content: clip(notice, CARD_CHARS, CARD_LINES), color: LIGHT.near }, prompt(""));
    return base("connecting", "CONNECTING", { content: HINT, color: LIGHT.ambient });
  }
  const title = `HACKOS  ·  ${view.model}`;
  switch (view.state) {
    case "off":
      return base("error", "HACKOS  ·  SETUP", { content: clip(view.error, CARD_CHARS, CARD_LINES), color: LIGHT.near });
    case "recording":
      return base("listening", "LISTENING  ·  release to send", { content: "Speak…", color: LIGHT.secondary }, prompt(""));
    case "transcribing":
      return base("thinking", "TRANSCRIBING", { content: "", color: LIGHT.ambient }, prompt(""));
    case "waking":
      return base("thinking", `WAKING THE GPU  ·  ${seconds(view, now)}s`, { content: "The GPU was asleep. The first answer takes about a minute.", color: LIGHT.secondary });
    case "thinking":
      return base("thinking", `THINKING  ·  ${seconds(view, now)}s`, { content: "", color: LIGHT.ambient });
    case "error":
      return base("error", "CHECK", { content: clip(view.error || "Something went wrong.", CARD_CHARS, CARD_LINES), color: LIGHT.near });
    case "answering": {
      const pages = paginate(plain(view.answer) + CARET);
      const p = pages.length - 1;
      const status = `ANSWER${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      return { ...base("answer", status, { content: pages[p] ?? "", color: LIGHT.primary }), page: p, pageCount: pages.length };
    }
    case "done":
    case "idle": {
      const text = view.answer ? plain(view.answer) : "";
      // A note from a failed recording ("Didn't catch that"), or from this page.
      const message = notice || view.error;
      if (!text) {
        const hint = message ? `${message}\n\n\n\nHOLD  talk    ·    DOUBLE TAP  new chat` : HINT;
        return base("paused", title, { content: hint, color: LIGHT.ambient }, prompt(view.prompt));
      }
      const pages = paginate(text);
      const p = Math.min(Math.max(page, 0), pages.length - 1);
      const status = `HACKOS  ·  ${view.stats || view.model}${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      // The note takes the prompt's line, so it shows on every page of the old answer.
      const question = message ? note(message) : prompt(view.prompt);
      return { ...base("answer", status, { content: pages[p] ?? "", color: LIGHT.primary }, question), page: p, pageCount: pages.length };
    }
  }
}
