/**
 * Answers end to end, without glasses or a network: the server Session with a fake socket and a fake Claude,
 * and the glasses page (src/answers/main.ts) with a fake Even host, page DOM and WebSocket.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioSpeakerRole, OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerHandlers, TranscriptLine } from "../server/answer";
import type { ServerMessage } from "../src/core/protocol";

type FakeStream = { transcript: TranscriptLine[]; handlers: AnswerHandlers; cancelled: boolean; vaultNotes: string | undefined };

const h = vi.hoisted(() => ({
  streams: [] as { transcript: unknown[]; handlers: unknown; cancelled: boolean; vaultNotes: string | undefined }[],
  vaultRecall: [] as boolean[],
  transcript: "What do you think about the launch date?",
  bridge: null as unknown,
}));

// The server module listens on import; give it a server object that does nothing.
vi.mock("node:http", () => ({ createServer: () => ({ listen: () => undefined }) }));
vi.mock("ws", () => ({ WebSocketServer: class { on(): void {} } }));
vi.mock("../server/answer", () => ({
  setPastMeetings: () => undefined,
  setVaultRecall: (on: boolean) => {
    h.vaultRecall.push(on);
  },
  pastMeetingsInclude: () => false,
  streamAnswer: (transcript: unknown[], handlers: unknown, vaultNotes?: string) => {
    const stream = { transcript: [...transcript], handlers, cancelled: false, vaultNotes };
    h.streams.push(stream);
    return () => {
      stream.cancelled = true;
    };
  },
}));
vi.mock("../server/whisper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/whisper")>()),
  transcribe: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return h.transcript;
  },
}));
vi.mock("../server/summarize", () => ({
  summarize: async () => ({ title: "Saved talk", summary: "S.", decisions: [], action_items: [], people: [], topics: [] }),
}));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: () => Promise.resolve(h.bridge),
}));

const streams = h.streams as unknown as FakeStream[];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for a condition, at most `ms`: the fixed waits were flaky on a loaded machine. */
const until = async (done: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !done(); t += 20) await wait(20);
};

// ---- Server Session ------------------------------------------------------------

class FakeWs {
  /** Every close and every end_meeting makes the Session save once. */
  static saves = 0;
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  private listeners = new Map<string, (...args: unknown[]) => void>();
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  text(message: unknown): void {
    if ((message as { type?: string }).type === "end_meeting") FakeWs.saves++;
    this.listeners.get("message")?.(Buffer.from(JSON.stringify(message)), false);
  }
  /** 100 ms of loud audio from the other person. */
  speech(frames: number): void {
    for (let f = 0; f < frames; f++) {
      const pcm = Buffer.alloc(1 + 3200);
      pcm[0] = 2;
      for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i / 5)), 1 + i * 2);
      this.listeners.get("message")?.(pcm, true);
    }
  }
  close(): void {
    FakeWs.saves++;
    this.readyState = 3;
    this.listeners.get("close")?.();
  }
  types(): string[] {
    return this.sent.map((m) => ("id" in m ? `${m.type}:${m.id}` : m.type));
  }
}

let Session: new (ws: FakeWs) => unknown;
let vaultRoot = "";
let meetings = "";
/** Saves (Session.endMeeting) started so far, and those still running. */
let ended = 0;
const saving = new Set<Promise<void>>();

/** Waits until every save asked for so far has ended, so none lands in the next test. */
async function drainSaves(): Promise<void> {
  await until(() => ended >= FakeWs.saves, 5000);
  await Promise.all(saving);
}

beforeAll(async () => {
  const vault = await mkdtemp(join(tmpdir(), "g2hud-answers-"));
  vaultRoot = vault;
  meetings = join(vault, "Meetings");
  process.env.HUD_TOKEN = "0123456789abcdef0123";
  process.env.OBSIDIAN_VAULT = vault;
  delete process.env.MEETINGS_FOLDER;
  delete process.env.RECALL_FOLDERS;
  delete process.env.LOOPS_SSH;
  ({ Session } = (await import("../server/index")) as unknown as { Session: typeof Session });
  const proto = Session.prototype as unknown as { endMeeting: () => Promise<void> };
  const endMeeting = proto.endMeeting;
  proto.endMeeting = function (this: unknown) {
    ended++;
    const save = endMeeting.call(this);
    saving.add(save);
    void save.finally(() => saving.delete(save));
    return save;
  };
});

afterAll(async () => {
  await drainSaves();
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("Session answers", () => {
  const sessions: FakeWs[] = [];
  const open = (): FakeWs => {
    const ws = new FakeWs();
    new Session(ws);
    sessions.push(ws);
    return ws;
  };
  beforeEach(() => {
    streams.length = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const ws of sessions.splice(0)) if (ws.readyState === 1) ws.close();
    await drainSaves();
  });

  it("does not cut a streaming answer for a newer line that is not a question", () => {
    const ws = open();
    ws.text({ type: "ask", text: "So what are you working on these days?" });
    streams[0]!.handlers.onStart();
    streams[0]!.handlers.onDelta("- Mostly the route");
    ws.text({ type: "ask", text: "I heard you moved teams." });
    expect(streams[0]!.cancelled).toBe(false);
    streams[1]!.handlers.onNone();
    streams[0]!.handlers.onDelta(" planner app.");
    streams[0]!.handlers.onDone();
    const types = ws.types();
    expect(types).toContain("answer_done:1");
    expect(types).not.toContain("answer_none:2");
    expect(types.indexOf("answer_done:1")).toBeGreaterThan(types.indexOf("thinking:2"));
  });

  it("answers a pending question when a later line is not a question, with no LISTENING flash", () => {
    const ws = open();
    ws.text({ type: "ask", text: "Where are you based now?" });
    ws.text({ type: "ask", text: "Take your time, no rush." });
    streams[1]!.handlers.onNone();
    streams[0]!.handlers.onStart();
    streams[0]!.handlers.onDelta("- In London.");
    streams[0]!.handlers.onDone();
    expect(ws.types().filter((t) => t.startsWith("answer_"))).toEqual(["answer_start:1", "answer_delta:1", "answer_done:1"]);
  });

  it("lets a newer question replace the older answer, and drops late text of the old one", () => {
    const ws = open();
    ws.text({ type: "ask", text: "What does it cost per seat?" });
    streams[0]!.handlers.onStart();
    ws.text({ type: "ask", text: "And where are you based?" });
    streams[1]!.handlers.onStart();
    expect(streams[0]!.cancelled).toBe(true);
    streams[0]!.handlers.onDelta("late");
    expect(ws.types()).not.toContain("answer_delta:1");
    expect(ws.types()).toContain("answer_start:2");
  });

  it("sends one answer_none when every pending line was not a question", () => {
    const ws = open();
    ws.text({ type: "ask", text: "That sounds about right." });
    ws.text({ type: "ask", text: "Okay, that makes sense." });
    streams[0]!.handlers.onNone();
    streams[1]!.handlers.onNone();
    expect(ws.types().filter((t) => t.startsWith("answer_none"))).toEqual(["answer_none:2"]);
  });

  it("with recall off, sends no cue and no vault notes, and ignores recall_shown", () => {
    expect(h.vaultRecall).toEqual([false]);
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, did you send the deck?" });
    ws.text({ type: "recall_shown", name: "Sarah Chen" });
    ws.text({ type: "reset" });
    expect(streams).toHaveLength(1);
    // The same request as before recall existed: streamAnswer's default for the notes is "".
    expect(streams[0]!.vaultNotes ?? "").toBe("");
    expect(ws.types()).toEqual(["status", "utterance", "thinking:1"]);
    streams[0]!.handlers.onStart();
    streams[0]!.handlers.onDelta("- Yes, this morning.");
    streams[0]!.handlers.onDone();
    expect(ws.types()).toContain("answer_done:1");
  });

  it("answers a short typed question", () => {
    const ws = open();
    ws.text({ type: "ask", text: "Why?" });
    expect(ws.types()).toContain("thinking:1");
    expect(streams).toHaveLength(1);
  });

  it("does not start a Claude request for a line transcribed after the socket closed", async () => {
    const ws = open();
    h.transcript = "What do you think about the launch date?";
    ws.speech(10);
    ws.close();
    await wait(150);
    expect(streams).toHaveLength(0);
  });

  it("ends the utterance in progress when audio stops (tap to pause)", async () => {
    const ws = open();
    h.transcript = "Are we still on for Friday then?";
    ws.speech(10);
    await until(() => ws.sent.some((m) => m.type === "utterance"));
    expect(ws.sent).toContainEqual({ type: "utterance", text: "Are we still on for Friday then?", speaker: "other" });
  });

  it("saves the last sentence in the note on a long press right after it", async () => {
    const ws = open();
    h.transcript = "Great, send me the deck by Friday. Bye.";
    ws.speech(10);
    ws.text({ type: "end_meeting" });
    await until(() => ws.sent.some((m) => m.type === "status" && m.text.startsWith("Saved")));
    expect(ws.sent).toContainEqual({ type: "status", text: "Saved: Saved talk" });
    const names = await readdir(meetings);
    expect(names.filter((n) => n.includes("(recording)"))).toEqual([]);
    const notes = await Promise.all(names.map((n) => readFile(join(meetings, n), "utf8")));
    expect(notes.some((t) => t.includes("Great, send me the deck by Friday. Bye."))).toBe(true);
  });

  it("reports a vault it cannot write once, and the idle timer does not retry it every 30 s", async () => {
    // Real setTimeout (Whisper, file writes), fake clock and idle timer.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await rm(meetings, { recursive: true, force: true });
    await writeFile(meetings, "not a folder");
    try {
      const ws = open();
      const errors = () => ws.sent.filter((m) => m.type === "error").length;
      h.transcript = "Can we check the budget numbers today?";
      ws.speech(10);
      // The live draft failed: told once.
      await until(() => errors() === 1, 5000);
      expect(errors()).toBe(1);
      // 10 minutes of silence: the idle end tries to save and fails.
      vi.advanceTimersByTime(10 * 60_000 + 30_000);
      await until(() => errors() === 2);
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(30_000);
        await wait(30);
      }
      expect(errors()).toBe(2);
      // A long press still tries again, and saves the conversation once the folder works.
      await rm(meetings, { force: true });
      ws.text({ type: "end_meeting" });
      await until(() => ws.sent.some((m) => m.type === "status" && m.text.startsWith("Saved")));
      expect(ws.sent).toContainEqual({ type: "status", text: "Saved: Saved talk" });
      const notes = await Promise.all((await readdir(meetings)).map((n) => readFile(join(meetings, n), "utf8")));
      expect(notes.some((t) => t.includes("Can we check the budget numbers today?"))).toBe(true);
    } finally {
      vi.useRealTimers();
      // Still the file when the test failed early; a folder is left for the other tests.
      await rm(meetings, { force: true }).catch(() => undefined);
    }
  });
});

// ---- Glasses page ---------------------------------------------------------------

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  message(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  binaryFrames(): number {
    return this.sent.filter((d) => typeof d !== "string").length;
  }
}
(FakeSocket as unknown as { OPEN: number }).OPEN = 1;

class FakeElement {
  textContent = "";
  className = "";
  value = "";
  removed = false;
  scrollTop = 0;
  scrollHeight = 0;
  append(): void {}
  addEventListener(): void {}
  remove(): void {
    this.removed = true;
  }
}

type Upgrade = { containerName?: string; content?: string; textColor?: number };
type HostOptions = {
  upgrade?: (u: Upgrade) => Promise<boolean> | boolean;
  audio?: (on: boolean) => boolean | Promise<boolean>;
  /** How long the host takes to create the page. */
  createMs?: number;
};

function fakeHost(options: HostOptions = {}) {
  const glasses = new Map<string, string>();
  const audio: boolean[] = [];
  const upgrades: Upgrade[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let pageReady = false;
  /** Text upgrades sent before the page existed. */
  let early = 0;
  let listener: ((event: EvenHubEvent) => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async (page: { textObject?: Upgrade[] }) => {
      if (options.createMs) await new Promise((resolve) => setTimeout(resolve, options.createMs));
      pageReady = true;
      for (const t of page.textObject ?? []) glasses.set(t.containerName ?? "", t.content ?? "");
      return StartUpPageCreateResult.success;
    },
    rebuildPageContainer: async () => true,
    onEvenHubEvent: (cb: (event: EvenHubEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    // The image loop sends one frame and then waits for ever: images are not under test.
    updateImageRawData: () => new Promise(() => undefined),
    textContainerUpgrade: async (u: Upgrade) => {
      upgrades.push(u);
      if (!pageReady) early++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const ok = await (options.upgrade?.(u) ?? true);
        if (ok) glasses.set(u.containerName ?? "", u.content ?? "");
        return ok;
      } finally {
        inFlight--;
      }
    },
    audioControl: async (on: boolean) => {
      audio.push(on);
      return options.audio?.(on) ?? true;
    },
  };
  return {
    bridge,
    glasses,
    audio,
    upgrades,
    maxInFlight: () => maxInFlight,
    early: () => early,
    subscribed: () => listener !== null,
    emit: (event: Partial<EvenHubEvent>) => listener?.(event as EvenHubEvent),
    gesture: (eventType: OsEventTypeList) => listener?.({ sysEvent: { eventType } } as unknown as EvenHubEvent),
    frame: () => listener?.({ audioEvent: { audioPcm: new Uint8Array(3200), speakerRole: AudioSpeakerRole.Other } } as unknown as EvenHubEvent),
  };
}

let host: ReturnType<typeof fakeHost>;
let elements: Map<string, FakeElement>;
/** Every element the page made: its log lines. */
let created: FakeElement[] = [];

async function bootPage(search: string, options: HostOptions = {}): Promise<FakeSocket | undefined> {
  vi.resetModules();
  FakeSocket.all = [];
  host = fakeHost(options);
  h.bridge = host.bridge;
  elements = new Map(["status", "log", "ask", "question", "end"].map((id) => [id, new FakeElement()]));
  created = [];
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173", search });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    },
    body: { prepend: () => undefined },
  });
  await import("../src/answers/main");
  const socket = FakeSocket.all[0];
  socket?.open();
  socket?.message({ type: "status", text: "Listening…" });
  await vi.advanceTimersByTimeAsync(500);
  return socket;
}

const KEY = "?k=0123456789abcdef&intro=0";

async function answer(socket: FakeSocket, id: number, question: string, text: string): Promise<void> {
  socket.message({ type: "utterance", text: question, speaker: "other" });
  socket.message({ type: "thinking", id });
  socket.message({ type: "answer_start", id, question });
  socket.message({ type: "answer_delta", id, text });
  socket.message({ type: "answer_done", id });
  await vi.advanceTimersByTimeAsync(500);
}

describe("Answers glasses page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a finished answer when the next remark is not a question", async () => {
    const socket = (await bootPage(KEY))!;
    await answer(socket, 1, "How is it priced?", "- It is priced per seat.");
    expect(host.glasses.get("body")).toBe("• It is priced per seat.");
    socket.message({ type: "utterance", text: "Okay, that makes sense.", speaker: "other" });
    socket.message({ type: "thinking", id: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("body")).toBe("• It is priced per seat.");
    expect(host.glasses.get("question")).toBe("“How is it priced?”");
    socket.message({ type: "answer_none", id: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("status")).toBe("Answer");
    expect(host.glasses.get("body")).toBe("• It is priced per seat.");
  });

  it("drops the rest of a streaming answer after a double tap", async () => {
    const socket = (await bootPage(KEY))!;
    socket.message({ type: "thinking", id: 1 });
    socket.message({ type: "answer_start", id: 1, question: "What does it cost?" });
    socket.message({ type: "answer_delta", id: 1, text: "- It is priced per seat" });
    await vi.advanceTimersByTimeAsync(500);
    host.gesture(OsEventTypeList.DOUBLE_CLICK_EVENT);
    socket.message({ type: "answer_delta", id: 1, text: " with a yearly contract." });
    socket.message({ type: "answer_done", id: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("hint")).toContain("Tap pause");
    expect(host.glasses.get("status")).toBe("Listening");
  });

  it("sends a text box again after the host refused the upgrade once", async () => {
    let refused = false;
    const socket = (await bootPage(KEY, {
      upgrade: (u) => {
        if (!refused && u.content?.includes("forty")) {
          refused = true;
          return false;
        }
        return true;
      },
    }))!;
    await answer(socket, 1, "What does it cost?", "- About forty dollars per seat.");
    expect(refused).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(host.glasses.get("body")).toBe("• About forty dollars per seat.");
  });

  it("runs one text upgrade at a time, so a slow upgrade cannot put old text on the glasses", async () => {
    const socket = (await bootPage(KEY, {
      upgrade: (u) => (u.content?.startsWith("Answer") ? new Promise((resolve) => setTimeout(() => resolve(true), 400)) : true),
    }))!;
    socket.message({ type: "thinking", id: 1 });
    socket.message({ type: "answer_start", id: 1, question: "What does it cost?" });
    socket.message({ type: "answer_delta", id: 1, text: "- Yes," });
    await vi.advanceTimersByTimeAsync(200);
    socket.message({ type: "answer_delta", id: 1, text: " about forty dollars per seat." });
    socket.message({ type: "answer_done", id: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.glasses.get("body")).toBe("• Yes, about forty dollars per seat.");
    expect(host.maxInFlight()).toBe(1);
  });

  it("does not stay frozen when one upgrade never answers", async () => {
    let hung = false;
    const socket = (await bootPage(KEY, {
      upgrade: (u) => {
        if (!hung && u.containerName === "status" && u.content === "Answer") {
          hung = true;
          return new Promise(() => undefined);
        }
        return true;
      },
    }))!;
    await answer(socket, 1, "Where are you based?", "- In London.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.glasses.get("body")).toBe("• In London.");
    expect(host.glasses.get("status")).toBe("Answer");
  });

  it("shows Paused, not Listening, when the glasses microphone does not open", async () => {
    const socket = (await bootPage(KEY, { audio: () => false }))!;
    expect(host.audio).toEqual([true]);
    await vi.advanceTimersByTimeAsync(9000);
    expect(host.glasses.get("status")).toBe("Paused");
    host.frame();
    expect(socket.binaryFrames()).toBe(0);
    host.gesture(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(10);
    expect(host.audio).toEqual([true, true]);
  });

  it("re-arms the microphone once when no audio arrives, then reports it", async () => {
    await bootPage(KEY);
    expect(host.audio).toEqual([true]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.audio).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.audio).toEqual([true, true, false]);
    expect(host.glasses.get("status")).toContain("Mic not available");
  });

  it("leaves the microphone alone while audio flows", async () => {
    await bootPage(KEY);
    for (let i = 0; i < 60; i++) {
      host.frame();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(host.audio).toEqual([true]);
  });

  it("releases the microphone, the socket and the display on a system exit", async () => {
    const socket = (await bootPage(KEY))!;
    const before = host.upgrades.length;
    host.gesture(OsEventTypeList.SYSTEM_EXIT_EVENT);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.audio).toEqual([true, false]);
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.all).toHaveLength(1);
    expect(host.subscribed()).toBe(false);
    expect(host.upgrades.length).toBe(before);
    socket.message({ type: "status", text: "Saved: x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.upgrades.length).toBe(before);
  });

  it("shows a recall cue for 10 s, acknowledges it after 3 s on the lens, and logs only the name", async () => {
    const socket = (await bootPage(KEY))!;
    const facts = ["12 Nov  ·  Pricing plan with Sarah", "Open: Send the deck", "Head of procurement, Northwind."];
    const acks = () => socket.sent.filter((d) => typeof d === "string" && (JSON.parse(d) as { type: string }).type === "recall_shown");
    socket.message({ type: "recall", name: "Sarah Chen", facts });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("question")).toBe("SARAH CHEN  ·  12 Nov  ·  Pricing plan with Sarah\nOpen: Send the deck  ·  Head of procurement, Northwind.");
    expect(host.glasses.get("status")).toBe("Listening");
    expect(host.glasses.get("hint")).toContain("Tap pause");
    expect(acks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(acks()).toEqual([JSON.stringify({ type: "recall_shown", name: "Sarah Chen" })]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(host.glasses.get("question")).toBe("");
    expect(acks()).toHaveLength(1);
    expect(created.filter((e) => e.className === "recall").map((e) => e.textContent)).toEqual(["Recall: Sarah Chen"]);
    expect(created.some((e) => facts.some((f) => e.textContent.includes(f)))).toBe(false);
  });

  it("opens the socket as the Answers app, so the server sends the vault graph", async () => {
    await bootPage(KEY);
    expect(FakeSocket.all[0]?.url).toContain("app=answers");
  });

  it("shows the recall view in the card when the graph has the person, acknowledges it after 3 s on the card, and logs only the name", async () => {
    const socket = (await bootPage(KEY))!;
    const card = { lead: "Head of procurement, Northwind", met: 4, seen: "12 Nov", last: "12 Nov  ·  Pricing plan", open: "Send the deck" };
    const facts = ["12 Nov  ·  Pricing plan", "Open: Send the deck", "Head of procurement"];
    const acks = () => socket.sent.filter((d) => typeof d === "string" && (JSON.parse(d) as { type: string }).type === "recall_shown");
    socket.message({
      type: "vault_graph",
      nodes: [{ id: 5, title: "Sarah Chen", kind: "person" }, { id: 6, title: "Pricing plan", kind: "topic" }],
      links: [[5, 6]],
      total: { notes: 214, people: 11 },
    });
    socket.message({ type: "recall", name: "Sarah Chen", facts, id: 5, card });
    await vi.advanceTimersByTimeAsync(500);
    expect(["card1", "card2", "card3", "card4"].map((n) => host.glasses.get(n))).toEqual(["Head of procurement", "Northwind  ·  met 4 times", "12 Nov  ·  Pricing plan", "Send the deck"]);
    expect(host.glasses.get("status")).toBe("Recall");
    expect(host.glasses.get("question")).toBe("");
    expect(host.glasses.get("body")).toBe("");
    expect(host.glasses.get("hint")).toBe("");
    expect(acks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(acks()).toEqual([JSON.stringify({ type: "recall_shown", name: "Sarah Chen" })]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(host.glasses.get("card1")).toBe("");
    expect(host.glasses.get("hint")).toContain("Tap pause");
    expect(created.some((e) => facts.some((f) => e.textContent.includes(f)) || e.textContent.includes("Pricing plan") || e.textContent.includes("procurement"))).toBe(false);
  });

  it("does not acknowledge a recall cue that the glasses never took", async () => {
    const socket = (await bootPage(KEY, { upgrade: (u) => !(u.containerName === "question" && u.content?.startsWith("SARAH CHEN")) }))!;
    const acks = () => socket.sent.filter((d) => typeof d === "string" && (JSON.parse(d) as { type: string }).type === "recall_shown");
    socket.message({ type: "recall", name: "Sarah Chen", facts: ["Open: Send the deck"] });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(host.upgrades.filter((u) => u.content?.startsWith("SARAH CHEN")).length).toBeGreaterThan(1);
    expect(host.glasses.get("question")).toBe("");
    expect(acks()).toEqual([]);
  });

  it("sends no text upgrade before the glasses page exists", async () => {
    await bootPage(KEY, { createMs: 800 });
    expect(host.upgrades).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.early()).toBe(0);
    expect(host.glasses.get("status")).toBe("Listening");
  });

  it("draws a state change from while the page was created, even when the microphone start hangs", async () => {
    // The greeting (CONNECTING to LISTENING) arrives before the page exists; audioControl never answers.
    await bootPage(KEY, { createMs: 800, audio: () => new Promise<boolean>(() => undefined) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.glasses.get("status")).toBe("Listening");
  });

  it("keeps Paused on the lens when the server greets a reconnect while the microphone is off", async () => {
    const socket = (await bootPage(KEY, { audio: () => false }))!;
    await vi.advanceTimersByTimeAsync(9000);
    expect(host.glasses.get("status")).toBe("Paused");
    socket.message({ type: "status", text: "Listening…" });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("status")).toBe("Paused");
    // Other server news still shows.
    socket.message({ type: "status", text: "Nothing to save yet." });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("status")).toBe("Nothing to save yet.");
  });

  it("keeps a recall cue off the quoted question while Claude is thinking, and draws it after", async () => {
    const socket = (await bootPage(KEY))!;
    socket.message({ type: "utterance", text: "Did you send the deck, Sarah?", speaker: "other" });
    socket.message({ type: "thinking", id: 1 });
    socket.message({ type: "recall", name: "Sarah Chen", facts: ["Open: Send the deck"] });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("question")).toBe("“Did you send the deck, Sarah?”");
    socket.message({ type: "answer_none", id: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.glasses.get("question")).toBe("SARAH CHEN  ·  Open: Send the deck");
  });

  it("opens no socket and removes the form in demo mode", async () => {
    await bootPage(`${KEY}&demo=answer`);
    expect(FakeSocket.all).toHaveLength(0);
    expect(elements.get("ask")?.removed).toBe(true);
    expect(elements.get("status")?.textContent).toBe("Demo scene: answer");
    // The demo takes the host it was given; let it draw before the next test sets up a new host.
    await vi.waitFor(() => expect(host.glasses.get("body")).toContain("route planner"));
  });
});
