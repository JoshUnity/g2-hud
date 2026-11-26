import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Nothing here may start Claude Code or reach a transcription server.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("the Agent SDK must not run in tests");
  }),
}));
vi.mock("../server/whisper", () => ({ transcribe: vi.fn(async () => "spoken words") }));

import { transcribe } from "../server/whisper";
import { Coder, describeTool, policy } from "../server/coder";
import { CAP_NOTE, CodeSession, DISCARD_NOTE, MAX_RECORDING_MS } from "../server/codesession";
import { iconFps, iconFrame } from "../src/code/glyph";
import { codeScreen, plain, tabStates } from "../src/code/view";
import { textWidth } from "../src/core/text";
import { speakerCode, type CodeHub, type CodeView } from "../src/core/protocol";

const root = "/work/app";

describe("approval policy", () => {
  it("lets reading and planning run on their own", () => {
    for (const tool of ["Read", "Glob", "Grep", "TodoWrite"]) expect(policy(tool, {}, root)).toBe("allow");
  });
  it("lets edits inside the project run on their own", () => {
    expect(policy("Edit", { file_path: "/work/app/src/a.ts" }, root)).toBe("allow");
    expect(policy("Write", { file_path: "src/new.ts" }, root)).toBe("allow");
  });
  it("asks for edits outside the project, to .git or to .env files", () => {
    expect(policy("Edit", { file_path: "/work/other/a.ts" }, root)).toBe("ask");
    expect(policy("Write", { file_path: "../escape.ts" }, root)).toBe("ask");
    expect(policy("Edit", { file_path: "/work/app/.git/config" }, root)).toBe("ask");
    expect(policy("Write", { file_path: "/work/app/.env" }, root)).toBe("ask");
    expect(policy("Write", { file_path: "/work/app/.env.local" }, root)).toBe("ask");
    expect(policy("Edit", {}, root)).toBe("ask");
  });
  it("asks for shell commands, web and unknown tools", () => {
    expect(policy("Bash", { command: "ls" }, root)).toBe("ask");
    expect(policy("WebFetch", { url: "https://x" }, root)).toBe("ask");
    expect(policy("mcp__x__y", {}, root)).toBe("ask");
  });
});

describe("tool lines", () => {
  it("are short and relative to the project", () => {
    expect(describeTool("Edit", { file_path: "/work/app/src/hud.ts" }, root)).toBe("Edit src/hud.ts");
    expect(describeTool("Bash", { command: "npm   test" }, root)).toBe("$ npm test");
    expect(describeTool("Grep", { pattern: "TODO" }, root)).toBe("Search “TODO”");
  });
});

const base: CodeView = { state: "idle", project: "g2-hud", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
const now = new Date(2026, 10, 23, 14, 0, 30);

describe("Code screen", () => {
  it("invites you to hold and talk when idle, with the file map at rest", () => {
    const s = codeScreen(base, 0, now);
    expect(s.status.content).toBe("Code  ·  g2-hud");
    expect(s.hint).toEqual({ content: "Hold talk  ·  Tap + hold tabs  ·  Double tap new", color: 1 });
    expect(s.body.content).toBe("");
    expect([s.scene, s.icon]).toEqual(["rest", "idle"]);
  });
  it("shows the newest steps while working: earlier ones dim, the current one on its own row", () => {
    const log = ["› a", "› b", "› c", "› d", "› e", "› Read src/x.ts"];
    const s = codeScreen({ ...base, state: "working", prompt: "add a test", log, startedAt: now.getTime() - 12_000 }, 0, now);
    expect(s.status.content).toBe("Working");
    expect(s.steps.content).toBe("d\ne\nRead src/x.ts".split("\n").slice(0, 0).concat(["c", "d", "e"]).join("\n"));
    expect(s.step.content).toBe("\n\n\nRead src/x.ts");
    expect(s.step.color).toBe(4);
    expect(s.steps.color).toBe(2);
    expect(s.body.content).toBe("");
    expect(s.prompt.content).toBe("“add a test”");
    expect([s.rows, s.scene, s.icon]).toEqual([4, "live", "busy"]);
  });
  it("puts the first step on row 0 when none is logged", () => {
    const s = codeScreen({ ...base, state: "working", log: [] }, 0, now);
    expect([s.rows, s.steps.content, s.step.content]).toEqual([1, "", "Starting…"]);
  });
  it("asks for approval with the command, the hint and the approval page", () => {
    const s = codeScreen({ ...base, state: "approval", approval: { id: 1, summary: "$ npm test", text: "$ npm test" } }, 0, now);
    expect(s.status.content).toBe("Allow?");
    expect(s.call.content).toBe("$ npm test");
    expect(s.hint.content).toBe("Tap allow  ·  Double tap deny");
    expect([s.scene, s.icon, s.tag, s.network]).toEqual(["approval", "approval", null, false]);
    // The tag, the folder and the network note come from the server, and only when it sent them.
    const card = codeScreen({ ...base, state: "approval", approval: { id: 1, summary: "x", text: "npm test", tool: "BASH", cwd: "~/Desktop/g2-hud", network: true } }, 0, now);
    expect([card.tag, card.network, card.folder]).toEqual(["BASH", true, { content: "in ~/Desktop/g2-hud", color: 2 }]);
  });
  it("pages a long result and shows the stats", () => {
    const result = Array.from({ length: 40 }, (_, i) => `- change ${i}`).join("\n");
    const s = codeScreen({ ...base, state: "done", result, stats: "2 files, 9 +  ·  31s" }, 1, now);
    expect(s.status.content).toContain("Done  ·  2 files");
    expect(s.status.content).toContain("2/5");
    expect(s.pageCount).toBe(5);
    expect(s.scene).toBe("blank");
  });
  it("labels recording, transcribing and errors", () => {
    expect(codeScreen({ ...base, state: "recording" }, 0, now).status.content).toBe("Listening  ·  release to send");
    expect(codeScreen({ ...base, state: "recording" }, 0, now).icon).toBe("recording");
    expect(codeScreen({ ...base, state: "transcribing" }, 0, now).status.content).toBe("Transcribing");
    const err = codeScreen({ ...base, state: "error", error: "Stopped: error max turns" }, 0, now);
    expect([err.body.content, err.body.color, err.icon]).toEqual(["Stopped: error max turns", 3, "dim"]);
  });
  it("cuts the status line so it never wraps, and keeps the page counter", () => {
    const s = codeScreen({ ...base, state: "done", result: "x\n".repeat(60), stats: "word ".repeat(40) }, 0, now, ["active", "idle", "idle"]);
    expect(s.status.content.endsWith("1/8")).toBe(true);
    // It must end before the tab squares: they start at x 462 with three tabs, the status at x 32.
    expect(textWidth(s.status.content)).toBeLessThanOrEqual(462 - 8 - 32);
  });
  it("shows tab squares: filled for this tab, a lit outline for one that waits for you, none for one tab", () => {
    const hub = { error: "", tabs: [1, 2, 3].map((id) => ({ id, view: { ...base, state: id === 3 ? ("approval" as const) : ("idle" as const) } })) };
    expect(tabStates(hub, 1)).toEqual(["active", "idle", "waiting"]);
    expect(tabStates(hub, 2)).toEqual(["idle", "active", "waiting"]);
    expect(tabStates({ error: "", tabs: [hub.tabs[0]!] }, 1)).toEqual([]);
    expect(codeScreen(base, 0, now, tabStates(hub, 1)).status.content).toBe("Code  ·  g2-hud");
  });
  it("drops markdown the glasses cannot show", () => {
    expect(plain("**Done.** Ran `npm test`\n- one")).toBe("Done. Ran npm test\n• one");
  });
});

describe("Code icon", () => {
  it("rests when idle and moves while busy", () => {
    expect(iconFrame("idle", 1)).toEqual(iconFrame("idle", 2));
    expect(iconFrame("busy", 0)).not.toEqual(iconFrame("busy", 0.2));
    expect(iconFps("idle")).toBe(0);
    expect(iconFps("busy")).toBe(6);
  });
  it("keeps the chevron and keeps the bitmap's size in every state", () => {
    for (const state of ["idle", "recording", "busy", "approval", "dim"] as const) {
      const grid = iconFrame(state, 0.1, 0.5);
      expect(grid).toHaveLength(12);
      for (const row of grid) expect(row).toHaveLength(12);
      expect(grid[1]?.slice(0, 2)).toMatch(/^[#+]{2}$/);
    }
  });
  it("raises the recording bar with the voice level", () => {
    const lit = (g: readonly string[]) => g.join("").split("#").length - 1;
    expect(lit(iconFrame("recording", 0, 1))).toBeGreaterThan(lit(iconFrame("recording", 0, 0)));
  });
  it("makes the approval block hollow and blinks it dim", () => {
    const a = iconFrame("approval", 0);
    const b = iconFrame("approval", 0.5);
    expect(a[5]?.slice(8, 10)).toBe("..");
    expect(a).not.toEqual(b);
    expect(b[3]?.slice(7, 11)).toBe("++++");
  });
});

// ---- Push-to-talk on the server (stand-in sockets; Coder.run and speech-to-text are replaced) ----

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  hubs: CodeHub[] = [];
  send(data: string): void {
    const message = JSON.parse(data) as { type: string; data: CodeHub };
    if (message.type === "code") this.hubs.push(message.data);
  }
  say(message: object): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  /** Loud 16 kHz audio, 50 ms a frame, tagged as the wearer's voice. */
  speak(ms: number): void {
    for (let t = 0; t < ms; t += 50) {
      const frame = Buffer.alloc(1 + 1600);
      frame[0] = speakerCode("self");
      for (let i = 0; i < 800; i++) frame.writeInt16LE(i % 2 ? 8000 : -8000, 1 + i * 2);
      this.emit("message", frame, true);
    }
  }
  tab(id = 1): CodeView | undefined {
    return this.hubs.at(-1)?.tabs.find((t) => t.id === id)?.view;
  }
}

describe("Code push-to-talk", () => {
  let dir = "";
  let run: ReturnType<typeof vi.spyOn>;
  const connect = () => {
    const ws = new FakeSocket();
    new CodeSession(ws as unknown as WebSocket);
    return ws;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(`${tmpdir()}/code-ptt-`));
    process.env.CODE_DIRS = dir;
    run = vi.spyOn(Coder.prototype, "run").mockResolvedValue(undefined);
  });
  afterEach(() => {
    run.mockClear();
    vi.mocked(transcribe).mockClear();
    vi.useRealTimers();
  });
  afterAll(() => {
    run.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs what was said on a release", async () => {
    const ws = connect();
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(1000);
    ws.say({ type: "code_ptt", tab: 1, on: false });
    await settle();
    expect(run).toHaveBeenCalledWith("spoken words");
  });

  it("drops a hold that the page ended with discard, and runs nothing", async () => {
    const ws = connect();
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(3000);
    ws.say({ type: "code_ptt", tab: 1, on: false, discard: true });
    expect(ws.tab()).toMatchObject({ state: "idle", error: DISCARD_NOTE });
    ws.say({ type: "code_ptt", tab: 1, on: false }); // a late release
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("drops a recording whose release never comes, after MAX_RECORDING_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ws = connect();
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(1000);
    vi.advanceTimersByTime(MAX_RECORDING_MS);
    expect(ws.tab()).toMatchObject({ state: "idle", error: CAP_NOTE });
    ws.speak(1000); // frames after the limit are ignored
    ws.say({ type: "code_ptt", tab: 1, on: false }); // the late release
    await vi.advanceTimersByTimeAsync(50);
    expect(transcribe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves recording when the connection that holds closes", async () => {
    const ws = connect();
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(1000);
    ws.emit("close");
    expect(connect().tab()).toMatchObject({ state: "idle", error: DISCARD_NOTE });
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("starts over on a second press: only the speech after it is transcribed", async () => {
    const ws = connect();
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(1000); // the release of this hold was lost
    ws.say({ type: "code_ptt", tab: 1, on: true });
    ws.speak(1000);
    ws.say({ type: "code_ptt", tab: 1, on: false });
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
    // One second of 16 kHz 16-bit speech (plus pre-roll), not two.
    expect(vi.mocked(transcribe).mock.calls[0]?.[0].length).toBeLessThan(1500 * 32);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
