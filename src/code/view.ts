import type { TabState } from "../core/board";
import { LIGHT, type Cell } from "../core/hud";
import type { ClientMessage, CodeHub, CodeView } from "../core/protocol";
import { MAX_TEXT_BYTES, clipPx, clockText, fitBytes, fitPx, paginatePx, textWidth } from "../core/text";
import type { IconState } from "./glyph";
import { rowShown, tabsX, type LensModel } from "./lens";
import { BODY_LINES, CALL_LINES, CALL_WIDTH, FOLDER, PROMPT_WRAP, STEPS, STEP_ROWS } from "./layout";

/**
 * What the Code glasses show for a tab: one page for every state (see layout.ts). The raster is drawn from the
 * lens model (lens.ts); this file decides the glasses text and what the raster shows.
 */

/** The text of the page, and what the picture shows. */
export type CodeScreen = {
  scene: LensModel["scene"];
  icon: IconState;
  status: Cell;
  prompt: Cell;
  steps: Cell;
  step: Cell;
  call: Cell;
  folder: Cell;
  hint: Cell;
  body: Cell;
  /** Step rows on show (0 to STEP_ROWS); the last one is the current step. */
  rows: number;
  page: number;
  pageCount: number;
  /** The approval card's tool tag and its network note, as the server sent them. */
  tag: string | null;
  network: boolean;
};

const WIDTH = 576;
const HINT = "Hold talk  ·  Tap + hold tabs  ·  Double tap new";
const NOTE_HINT = "Hold talk  ·  Double tap new session";
const ALLOW_HINT = "Tap allow  ·  Double tap deny";
const MORE_HINT = "Swipe more  ·  Double tap deny";

/** A page of the call holds this many lines: the card in the raster is 96 px tall (the board's), so no more fit above the countdown bar. */
export const APPROVAL_LINES = CALL_LINES;

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

/** The tab squares of the header: filled for this tab, a lit outline with a core for one waiting for you, an outline for the others. None for one tab. */
export function tabStates(hub: CodeHub | null, active: number): TabState[] {
  if (!hub || hub.tabs.length < 2) return [];
  return hub.tabs.map((t) => (t.id === active ? "active" : t.view.state === "approval" ? "waiting" : "idle"));
}

/** Menu items may have at most 32 UTF-8 bytes, or the SDK refuses the whole page. Only the name is cut, so "  !" stays. */
export function menuLabel(index: number, project: string, waiting: boolean): string {
  const prefix = `${index + 1}  `;
  const suffix = waiting ? "  !" : "";
  return prefix + fitBytes(project, 32 - prefix.length - 3) + suffix;
}

/** Markdown the glasses can't show: emphasis, code fences and backticks. */
export function plain(text: string): string {
  return text
    .replace(/```[a-z]*\n?/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
    .trim();
}

/**
 * The call, cut into lines that each fit the card, with nothing lost: line breaks, spaces and every character
 * stay. A line breaks after its last space when it is too wide, else inside a word. The text is printable ASCII
 * (visible() in server/coder.ts), so the width of a line is measured, never counted.
 */
export function wrapCall(text: string, maxPx = CALL_WIDTH): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const ch of paragraph) {
      if (line && textWidth(line + ch) > maxPx) {
        const space = line.lastIndexOf(" ");
        if (space >= 0 && ch !== " ") {
          lines.push(line.slice(0, space + 1));
          line = line.slice(space + 1);
        } else {
          lines.push(line);
          line = "";
        }
      }
      line += ch;
    }
    lines.push(line);
  }
  return lines;
}

/** The pages of a call: APPROVAL_LINES lines each, and under the byte cap of a text container. Always at least one page. */
export function approvalPages(text: string): string[] {
  const encoder = new TextEncoder();
  const pages: string[] = [];
  let page: string[] = [];
  let bytes = 0;
  for (const line of wrapCall(text)) {
    const size = encoder.encode(line).length + 1;
    if (page.length === APPROVAL_LINES || (page.length > 0 && bytes + size - 1 > MAX_TEXT_BYTES)) {
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

/** The steps on show: the last STEP_ROWS log lines, each cut to the steps box. The "›" that marks a tool call is dropped. */
export function stepLines(log: readonly string[]): string[] {
  return log.slice(-STEP_ROWS).map((line) => fitPx(line.replace(/^›\s*/, ""), STEPS.width));
}


/** A tool call is a log line that starts with "›". The log keeps 40 lines, so a count that reaches it is "at least". */
export const LOG_LIMIT = 40;
export function stepCount(log: readonly string[]): { count: number; atLeast: boolean } {
  return { count: log.filter((line) => line.startsWith("›")).length, atLeast: log.length >= LOG_LIMIT };
}

const emptyCell: Cell = { content: "", color: LIGHT.secondary };

/**
 * The glasses screen for a Code tab. `tabs` are the header's tab squares (they decide how wide the status may be);
 * `notice` is a note from this page itself (no pairing key, a microphone that did not open): it takes the
 * prompt's place. `load` is the map's opening progress: the step rows come in with it, as on the board.
 */
export function codeScreen(view: CodeView | null, page: number, now: Date, tabs: readonly TabState[] = [], notice = "", load = 1): CodeScreen {
  void now;
  const quote = (p: string, lines = 2): Cell => ({ content: p ? clipPx(`“${p}”`, PROMPT_WRAP, lines) : "", color: LIGHT.secondary });
  const note = (text: string): Cell => ({ content: clipPx(text, PROMPT_WRAP, 2), color: LIGHT.near });
  /** The status line, cut so it never runs under the tab squares; `tail` (a page counter) is kept whole. */
  const status = (text: string, tail = ""): Cell => ({ content: fitPx(text, tabsX(tabs.length) - 8 - 32 - textWidth(tail)) + tail, color: LIGHT.near });
  const base = (icon: IconState, statusCell: Cell, over: Partial<CodeScreen> = {}): CodeScreen => ({
    scene: "blank",
    icon,
    status: statusCell,
    prompt: notice ? note(notice) : quote(view?.prompt ?? ""),
    steps: emptyCell,
    step: emptyCell,
    call: emptyCell,
    folder: emptyCell,
    hint: emptyCell,
    body: emptyCell,
    rows: 0,
    page: 0,
    pageCount: 1,
    tag: null,
    network: false,
    ...over,
  });
  /** The body starts under the prompt: with a two-line prompt its first row is empty. */
  const twoLines = (prompt: Cell): boolean => prompt.content.split("\n").length >= 2;
  const lead = (prompt: Cell): string => (twoLines(prompt) ? "\n" : "");
  const bodyRows = (prompt: Cell): number => (twoLines(prompt) ? BODY_LINES - 1 : BODY_LINES);
  const message = (text: string, color: number, prompt: Cell): Cell => ({ content: lead(prompt) + clipPx(text, WIDTH, bodyRows(prompt)), color });
  const hint = (text: string): Cell => ({ content: text, color: LIGHT.ambient });

  if (!view) {
    if (notice) return base("dim", status("Check"), { prompt: quote(""), body: message(notice, LIGHT.near, quote("")) });
    return base("dim", status("Connecting"), { prompt: quote(""), hint: hint(HINT) });
  }
  const title = `Code  ·  ${view.project}`;
  switch (view.state) {
    case "off": {
      const p = quote("");
      return base("dim", status("Code  ·  Setup"), { prompt: p, body: message(view.error || "Code is not set up.", LIGHT.near, p) });
    }
    case "recording":
      return base("recording", status("Listening  ·  release to send"), { prompt: notice ? note(notice) : quote(""), scene: "rest" });
    case "transcribing":
      return base("busy", status("Transcribing"), { prompt: notice ? note(notice) : quote(""), scene: "rest" });
    case "working": {
      const lines = stepLines(view.log);
      // Nothing logged yet: one row, so the node of the current step is on the rail from the first moment.
      const shown = lines.length > 0 ? lines : ["Starting…"];
      const rows = shown.map((line, i) => (rowShown(i, load) ? line : ""));
      return base("busy", status("Working"), {
        steps: { content: rows.slice(0, -1).join("\n"), color: LIGHT.secondary },
        step: { content: "\n".repeat(rows.length - 1) + (rows[rows.length - 1] ?? ""), color: LIGHT.primary },
        scene: "live",
        rows: shown.length,
      });
    }
    case "approval": {
      // The whole call, in pages of APPROVAL_LINES lines; a tap allows only on the last page.
      const pages = approvalPages(view.approval?.text ?? "");
      const p = Math.min(Math.max(page, 0), pages.length - 1);
      const last = p === pages.length - 1;
      const lines = (pages[p] ?? "").split("\n");
      const cwd = view.approval?.cwd;
      return base("approval", status("Allow?", pages.length > 1 ? `  ·  ${p + 1}/${pages.length}` : ""), {
        scene: "approval",
        prompt: notice ? note(notice) : quote(view.prompt, 1),
        call: { content: pages[p] ?? "", color: LIGHT.primary },
        // The folder line sits where a second line of the call would: it shows only when the call has one line.
        folder: cwd && lines.length === 1 ? { content: fitPx(`in ${cwd}`, FOLDER.width), color: LIGHT.secondary } : emptyCell,
        hint: hint(last ? ALLOW_HINT : MORE_HINT),
        page: p,
        pageCount: pages.length,
        tag: view.approval?.tool ?? null,
        network: view.approval?.network === true,
      });
    }
    case "error": {
      const p = notice ? note(notice) : quote(view.prompt);
      return base("dim", status("Check"), { prompt: p, body: message(view.error || "Something went wrong.", LIGHT.near, p) });
    }
    case "done":
    case "idle": {
      const text = view.result ? plain(view.result) : "";
      // A note from a failed recording ("Didn't catch that"), a setup error, or a note from this page.
      const problem = notice || view.error;
      if (!text) {
        const p = quote(view.prompt);
        if (problem) return base("idle", status(title), { prompt: p, body: message(problem, LIGHT.secondary, p), hint: hint(NOTE_HINT) });
        return base("idle", status(title), { prompt: p, hint: hint(HINT), scene: "rest" });
      }
      // The note takes the prompt's place, so it shows on every page of the old result.
      const p = problem ? note(problem) : quote(view.prompt);
      const pages = paginatePx(text, bodyRows(p), WIDTH);
      const at = Math.min(Math.max(page, 0), pages.length - 1);
      return base(
        "idle",
        status(`Done  ·  ${view.stats || view.project}`, pages.length > 1 ? `  ·  ${at + 1}/${pages.length}` : ""),
        { prompt: p, body: { content: lead(p) + (pages[at] ?? ""), color: LIGHT.primary }, page: at, pageCount: pages.length },
      );
    }
  }
}

/** The glasses text of a screen as the board's `tx` calls: each container's lines at its place, 27 px apart. Empty lines are not text. */
export function screenTexts(s: CodeScreen, places: Record<string, { x: number; y: number }>): { text: string; x: number; y: number; level: number }[] {
  const cells: [string, Cell][] = [["status", s.status], ["prompt", s.prompt], ["steps", s.steps], ["step", s.step], ["call", s.call], ["folder", s.folder], ["hint", s.hint], ["body", s.body]];
  return cells.flatMap(([name, cell]) => {
    const at = places[name];
    if (!at) return [];
    return cell.content.split("\n").flatMap((text, i) => (text ? [{ text, x: at.x, y: at.y + 27 * i, level: cell.color }] : []));
  });
}

/** What the glasses show after a render pass: the approval card that is drawn, if any. `drawn` is false when a write failed or the page is not the approval page. */
export function seenAfterRender(prev: SeenApproval | null, drawn: boolean, tab: number, view: CodeView | null, screen: CodeScreen, now: number): SeenApproval | null {
  const approval = drawn && screen.scene === "approval" && view?.state === "approval" ? view.approval : null;
  if (!approval) return null;
  const last = screen.page === screen.pageCount - 1;
  // Keep the time the card first showed this page state.
  if (prev?.tab === tab && prev.id === approval.id && prev.last === last) return prev;
  return { tab, id: approval.id, last, at: now };
}

/**
 * A tap may allow only the request that is on the glasses, on its last page, after it showed
 * for MIN_SEEN_MS, and only while the page in hand (it may have been swiped since) is the last one. `acceptedText`
 * is the call text the glasses accepted: ids restart with a server, so a request is told apart by id and text.
 */
export function canAllow(seen: SeenApproval | null, tab: number, view: CodeView | null, page: number, now: number, acceptedText?: string): boolean {
  if (!seen?.last || seen.tab !== tab || view?.state !== "approval" || view.approval?.id !== seen.id) return false;
  // A server that restarted counts ids from 1 again: the call that was accepted must be this request's call.
  if (acceptedText !== undefined && acceptedText !== view.approval.text) return false;
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
