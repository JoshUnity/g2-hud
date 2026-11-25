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
import { markFps, renderMark } from "../src/code/mark";
import { codeScreen, plain, tabStrip } from "../src/code/view";
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
  it("invites you to hold and talk when idle", () => {
    const s = codeScreen(base, 0, now);
    expect(s.status.content).toBe("CODE  ·  g2-hud");
    expect(s.card.content).toContain("Hold and speak");
  });
  it("shows the newest steps while working, with elapsed time", () => {
    const s = codeScreen({ ...base, state: "working", prompt: "add a test", log: ["a", "b", "› Read src/x.ts"], startedAt: now.getTime() - 12_000 }, 0, now);
    expect(s.status.content).toBe("WORKING  ·  12s");
    expect(s.card.content.endsWith("› Read src/x.ts")).toBe(true);
    expect(s.question.content).toBe("“add a test”");
    expect(s.mark).toBe("working");
  });
  it("asks for approval with the command", () => {
    const s = codeScreen({ ...base, state: "approval", approval: { id: 1, summary: "$ npm test", text: "$ npm test" } }, 0, now);
    expect(s.status.content).toBe("ALLOW?");
    expect(s.card.content).toContain("$ npm test");
    expect(s.card.content).toContain("TAP  allow");
  });
  it("pages a long result and shows the stats", () => {
    const result = Array.from({ length: 20 }, (_, i) => `- change ${i}`).join("\n");
    const s = codeScreen({ ...base, state: "done", result, stats: "2 files, 9 +  ·  31s" }, 1, now);
    expect(s.status.content).toContain("DONE  ·  2 files");
    expect(s.status.content).toContain("2/4");
    expect(s.pageCount).toBe(4);
  });
  it("shows tab dots, with ! for a tab that waits for you", () => {
    const hub = { error: "", tabs: [1, 2, 3].map((id) => ({ id, view: { ...base, state: id === 3 ? ("approval" as const) : ("idle" as const) } })) };
    expect(tabStrip(hub, 1)).toBe("● ○ !   ");
    expect(codeScreen(base, 0, now, tabStrip(hub, 2)).status.content).toBe("○ ● !   CODE  ·  g2-hud");
    expect(tabStrip({ error: "", tabs: [hub.tabs[0]!] }, 1)).toBe("");
  });
  it("drops markdown the glasses cannot show", () => {
    expect(plain("**Done.** Ran `npm test`\n- one")).toBe("Done. Ran npm test\n• one");
  });
});

describe("Code mark", () => {
  it("rests when idle and moves while working", () => {
    expect(renderMark("idle", 1, 5, 0)).toEqual(renderMark("idle", 2, 5, 0));
    expect(renderMark("working", 1, 1, 0)).not.toEqual(renderMark("working", 1.2, 1.2, 0));
    expect(markFps("idle", 5, 0)).toBe(0);
    expect(markFps("working", 1, 0)).toBe(8);
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
