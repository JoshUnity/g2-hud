import type { ClientMessage, CodeHub, CodeView } from "../core/protocol";
import { MAX_TEXT_BYTES, clockText, fitBytes } from "../core/text";
import { CARD_CHARS, CARD_LINES, LIGHT, QUESTION_CHARS, clip, formatAnswer, paginate, type Cell } from "../answers/hud";
import type { MarkMode } from "./mark";

export type CodeScreen = { mark: MarkMode; status: Cell; clock: Cell; question: Cell; card: Cell; page: number; pageCount: number };

const HINT = ["Hold and speak an instruction.", "", "", "", "HOLD  talk    ·    TAP + HOLD  tabs    ·    DOUBLE TAP  new"].join("\n");
const ALLOW_HINT = "TAP  allow    ·    DOUBLE TAP  deny";
const MORE_HINT = "SWIPE  more    ·    DOUBLE TAP  deny";
/**
 * Approval lines are wrapped at a width no text can overflow: the widest printable-ASCII glyph is '@'
 * (17 px) plus at most 1 px of kerning, and 31 x 18 = 558 px, the card's inner width. A line wider than
 * the card would be wrapped again by the firmware and push the end of the call below the card.
 */
export const APPROVAL_CHARS = 31;

/** The approval card that the last finished render pass put on the glasses: `last` when it was its last page, `at` since when. */
export type SeenApproval = { tab: number; id: number; last: boolean; at: number };
/** A request a tap or a double tap answers. */
export type ApprovalRef = { tab: number; id: number };

/** A tap allows only after the last page was on the glasses this long, so a tap meant for the card before cannot allow this one. */
export const MIN_SEEN_MS = 700;
/**
 * Not checked on real glasses: the firmware may send a tap before a double tap, or before the
 * hold of "tap, then hold" (the system menu). So an allow waits this long, and a double tap
 * (deny) or a hold (nothing) in that time cancels it. A deny is never delayed.
 */
export const ALLOW_DELAY_MS = 400;
/**
 * After a task ends, the lens can still show it working for a moment. A double tap in that
 * time is meant as "stop", so it does not start a new session.
 */
export const NEW_SESSION_GRACE_MS = 1500;

/**
 * A hold ends on its own after this time and sends nothing: its release was probably lost. Below the
 * server's own limit (MAX_RECORDING_MS in server/codesession.ts and server/hackos.ts), so the page stops first.
 */
export const MAX_HOLD_MS = 60_000;
/** Notes on the glasses and the phone page when a hold was thrown away. */
export const HOLD_LIMIT_NOTE = `Recording stopped after ${MAX_HOLD_MS / 1000} seconds. Nothing was sent. Hold and speak again.`;
export const HOLD_DROPPED_NOTE = "Recording stopped. Nothing was sent. Hold and speak again.";

const BUSY = new Set<CodeView["state"]>(["recording", "transcribing", "working", "approval"]);
/** States the active tab rests in after a run; leaving BUSY for one of them starts the grace time for "new". */
export const busy = (view: CodeView | null): boolean => !!view && BUSY.has(view.state);

/** Tab dots for the status line: ● this tab, ! a tab waiting for you, ○ the others. */
export function tabStrip(hub: CodeHub | null, active: number): string {
  if (!hub || hub.tabs.length < 2) return "";
  return hub.tabs.map((t) => (t.id === active ? "●" : t.view.state === "approval" ? "!" : "○")).join(" ") + "   ";
}

/** Menu items may have at most 32 UTF-8 bytes, or the SDK refuses the whole page. Only the name is cut, so "  !" stays. */
export function menuLabel(index: number, project: string, waiting: boolean): string {
  const prefix = `${index + 1}  `;
  const suffix = waiting ? "  !" : "";
  return prefix + fitBytes(project, 32 - prefix.length - 3) + suffix;
}

/** Markdown the glasses can't show: emphasis, code fences and backticks. */
export function plain(text: string): string {
  return formatAnswer(text.replace(/```[a-z]*\n?/g, "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, ""));
}

/** Body lines, padded with blank lines to `bodyLines`, then the hint, so the hint is always on the same line. */
function withHint(body: string, bodyLines: number, hint: string): string {
  const lines = body ? body.split("\n") : [];
  while (lines.length < bodyLines) lines.push("");
  return [...lines, hint].join("\n");
}

/**
 * The glasses screen for a Code tab. `notice` is a note from this page itself (no pairing
 * key, a microphone that did not open); it takes the prompt's line.
 */
export function codeScreen(view: CodeView | null, page: number, now: Date, strip = "", notice = ""): CodeScreen {
  const clock = { content: clockText(now), color: LIGHT.ambient };
  const prompt = (p: string): Cell => ({ content: p ? clip(`“${p}”`, QUESTION_CHARS, 2) : "", color: LIGHT.secondary });
  const note = (text: string): Cell => ({ content: clip(text, QUESTION_CHARS, 2), color: LIGHT.near });
  const base = (mark: MarkMode, status: string, card: Cell, question: Cell = notice ? note(notice) : prompt(view?.prompt ?? "")): CodeScreen => ({
    mark,
    status: { content: strip + status, color: LIGHT.secondary },
    clock,
    question,
    card,
    page: 0,
    pageCount: 1,
  });
  if (!view) {
    if (notice) return base("error", "CHECK", { content: clip(notice, CARD_CHARS, CARD_LINES), color: LIGHT.near }, prompt(""));
    return base("off", "CONNECTING", { content: HINT, color: LIGHT.ambient });
  }
  const title = `CODE  ·  ${view.project}`;
  switch (view.state) {
    case "off":
      return base("off", "CODE  ·  SETUP", { content: clip(view.error, CARD_CHARS, CARD_LINES), color: LIGHT.near });
    case "recording":
      return base("recording", "LISTENING  ·  release to send", { content: "Speak your instruction…", color: LIGHT.secondary }, notice ? note(notice) : prompt(""));
    case "transcribing":
      return base("working", "TRANSCRIBING", { content: "", color: LIGHT.ambient }, notice ? note(notice) : prompt(""));
    case "working": {
      const seconds = view.startedAt ? Math.round((now.getTime() - view.startedAt) / 1000) : 0;
      return base("working", `WORKING  ·  ${seconds}s`, { content: view.log.slice(-CARD_LINES).map((l) => clip(l, CARD_CHARS, 1)).join("\n"), color: LIGHT.primary });
    }
    case "approval": {
      // The whole call, in pages of 5 lines above the hint; a tap allows only on the last page.
      // The text is printable ASCII without the backtick (server/coder.ts visible()); the byte cap leaves room for the hint all the same.
      const pages = paginate(view.approval?.text ?? "", CARD_LINES - 1, APPROVAL_CHARS, MAX_TEXT_BYTES - 64);
      const p = Math.min(Math.max(page, 0), pages.length - 1);
      const last = p === pages.length - 1;
      const status = `ALLOW?${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      const card = withHint(pages[p] ?? "", CARD_LINES - 1, last ? ALLOW_HINT : MORE_HINT);
      return { ...base("approval", status, { content: card, color: LIGHT.primary }), page: p, pageCount: pages.length };
    }
    case "error":
      return base("error", "CHECK", { content: clip(view.error || "Something went wrong.", CARD_CHARS, CARD_LINES), color: LIGHT.near });
    case "done":
    case "idle": {
      const text = view.result ? plain(view.result) : "";
      // A note from a failed recording ("Didn't catch that"), a setup error, or a note from this page.
      const message = notice || view.error;
      if (!text) {
        const hint = message ? withHint(clip(message, CARD_CHARS, 3), 4, "HOLD  talk    ·    DOUBLE TAP  new session") : HINT;
        return base(view.state === "done" ? "done" : "idle", title, { content: hint, color: LIGHT.ambient }, prompt(view.prompt));
      }
      const pages = paginate(text);
      const p = Math.min(Math.max(page, 0), pages.length - 1);
      const status = `DONE  ·  ${view.stats || view.project}${pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""}`;
      // The note takes the prompt's line, so it shows on every page of the old result.
      const question = message ? note(message) : prompt(view.prompt);
      return { ...base("done", status, { content: pages[p] ?? "", color: LIGHT.primary }, question), page: p, pageCount: pages.length };
    }
  }
}

/** What the glasses show after a render pass: the approval card that is drawn, if any. `drawn` is false when a write failed. */
export function seenAfterRender(prev: SeenApproval | null, drawn: boolean, tab: number, view: CodeView | null, screen: CodeScreen, now: number): SeenApproval | null {
  const approval = drawn && view?.state === "approval" ? view.approval : null;
  if (!approval) return null;
  const last = screen.page === screen.pageCount - 1;
  // Keep the time the card first showed this page state.
  if (prev?.tab === tab && prev.id === approval.id && prev.last === last) return prev;
  return { tab, id: approval.id, last, at: now };
}

/**
 * A tap may allow only the request that is on the glasses, on its last page, after it showed
 * for MIN_SEEN_MS, and only while the page in hand (it may have been swiped since) is the last one.
 */
export function canAllow(seen: SeenApproval | null, tab: number, view: CodeView | null, page: number, now: number): boolean {
  if (!seen?.last || seen.tab !== tab || view?.state !== "approval" || view.approval?.id !== seen.id) return false;
  if (now - seen.at < MIN_SEEN_MS) return false;
  const s = codeScreen(view, page, new Date(now));
  return s.page === s.pageCount - 1;
}

/**
 * What a double tap sends. `target` is the request on the glasses (or the one a pending tap
 * was for): it is denied. A request that is not on the glasses yet gets no answer; it stays
 * pending. Otherwise stop a run or the speech being transcribed, or start a new session, but
 * not just after a run ended (`restSince`).
 */
export function doubleTapAction(target: ApprovalRef | null, tab: number, view: CodeView | null, restSince: number, now: number): ClientMessage | null {
  if (target) return { type: "code_decide", tab: target.tab, id: target.id, allow: false };
  if (!view || view.approval || view.state === "approval") return null;
  if (view.state === "working" || view.state === "transcribing") return { type: "code_stop", tab };
  if (busy(view)) return null;
  return now - restSince >= NEW_SESSION_GRACE_MS ? { type: "code_new", tab } : null;
}
