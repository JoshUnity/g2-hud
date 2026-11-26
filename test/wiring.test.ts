/**
 * Vault recall wiring in the server Session (server/index.ts), with recall on and the fixture vault:
 * the lens cue, recall_shown, the <vault_notes> block in the request, the audit list in the saved note,
 * rescans kept off the answer path, and a broken vault that never breaks an answer.
 * No network and no Claude: the socket, Whisper, the summary and streamAnswer are fakes.
 */
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerHandlers } from "../server/answer";
import { nodeTitle } from "../server/graph";
import { RECALL_CHARS } from "../server/recall";
import type { Vault } from "../server/vault";
import type { ServerMessage } from "../src/core/protocol";

type FakeStream = { handlers: AnswerHandlers; vaultNotes: string | undefined };
type RecallMessage = Extract<ServerMessage, { type: "recall" }>;

const h = vi.hoisted(() => ({
  streams: [] as { handlers: unknown; vaultNotes: string | undefined }[],
  /** "stream" for each streamAnswer call, "refresh" / "refresh!" for each Vault.refresh() / refresh(true). */
  events: [] as string[],
  vaultRecall: [] as boolean[],
  pastInclude: false,
  throwIndex: false,
  vault: null as unknown,
  transcript: "",
  /** The summary waits for this; summarizing counts the calls. */
  summaryGate: null as Promise<void> | null,
  summarizing: 0,
}));

// The server module listens on import; give it a server object that does nothing.
vi.mock("node:http", () => ({ createServer: () => ({ listen: () => undefined }) }));
vi.mock("ws", () => ({ WebSocketServer: class { on(): void {} } }));
vi.mock("../server/answer", () => ({
  setPastMeetings: () => undefined,
  setVaultRecall: (on: boolean) => {
    h.vaultRecall.push(on);
  },
  pastMeetingsInclude: () => h.pastInclude,
  streamAnswer: (_transcript: unknown[], handlers: unknown, vaultNotes?: string) => {
    h.events.push("stream");
    h.streams.push({ handlers, vaultNotes });
    return () => undefined;
  },
}));
vi.mock("../server/vault", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/vault")>();
  class SpyVault extends real.Vault {
    constructor(...args: ConstructorParameters<typeof real.Vault>) {
      super(...args);
      h.vault = this;
    }
    override get index() {
      if (h.throwIndex) throw new Error("index broke");
      return super.index;
    }
    override refresh(force = false): Promise<boolean> {
      h.events.push(force ? "refresh!" : "refresh");
      return super.refresh(force);
    }
  }
  return { ...real, Vault: SpyVault };
});
vi.mock("../server/whisper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/whisper")>()),
  transcribe: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return h.transcript;
  },
}));
vi.mock("../server/summarize", () => ({
  summarize: async () => {
    h.summarizing++;
    await h.summaryGate;
    return { title: "Saved talk", summary: "S.", decisions: [], action_items: [], people: [], topics: [] };
  },
}));

const streams = h.streams as unknown as FakeStream[];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for a condition (real timers), at most `ms`. */
const until = async (done: () => boolean, ms = 15_000) => {
  for (let t = 0; t < ms && !done(); t += 20) await wait(20);
};
const FIXTURE = join(import.meta.dirname, "fixtures", "vault");

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
  /** 100 ms frames of loud audio, from the other person unless `speaker` is 1 (the wearer). */
  speech(frames: number, speaker = 2): void {
    for (let f = 0; f < frames; f++) {
      const pcm = Buffer.alloc(1 + 3200);
      pcm[0] = speaker;
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
  cues(): RecallMessage[] {
    return this.sent.filter((m): m is RecallMessage => m.type === "recall");
  }
}

let Session: new (ws: FakeWs, app?: string | null) => unknown;
let vaultDir = "";
const vault = () => h.vault as Vault;
/** Saves (Session.endMeeting) started so far, and those still running. */
let ended = 0;
const saving = new Set<Promise<void>>();

/** Waits until every save asked for so far has ended, so no note and no "refresh!" lands in the next test. */
async function drainSaves(): Promise<void> {
  await until(() => ended >= FakeWs.saves, 5000);
  await Promise.all(saving);
}

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "g2vault-"));
  await cp(FIXTURE, vaultDir, { recursive: true });
  vi.stubEnv("HUD_TOKEN", "0123456789abcdef0123");
  vi.stubEnv("OBSIDIAN_VAULT", vaultDir);
  vi.stubEnv("RECALL_FOLDERS", "People,Projects,Daily,Meetings");
  vi.stubEnv("HUD_USER_NAME", "Josh");
  for (const name of ["MEETINGS_FOLDER", "LOOPS_SSH", "RECALL_EXCLUDE", "RECALL_PEOPLE", "RECALL_CUE"]) vi.stubEnv(name, undefined);
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
  // The first scan runs in the background, never awaited by the server.
  for (let i = 0; i < 250 && !vault()?.index; i++) await wait(20);
});

afterAll(async () => {
  await drainSaves();
  vi.unstubAllEnvs();
  await rm(vaultDir, { recursive: true, force: true });
});

describe("Session vault recall", () => {
  const sockets: FakeWs[] = [];
  const open = (app: string | null = null): FakeWs => {
    const ws = new FakeWs();
    new Session(ws, app);
    sockets.push(ws);
    return ws;
  };
  let now = 0;
  const later = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  beforeEach(() => {
    streams.length = 0;
    h.events.length = 0;
    h.pastInclude = false;
    h.throwIndex = false;
    h.summaryGate = null;
    h.summarizing = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    now = new Date(2026, 10, 25, 12).getTime();
    vi.setSystemTime(now);
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const ws of sockets.splice(0)) if (ws.readyState === 1) ws.close();
    await drainSaves();
  });

  it("turns recall on at start-up and scans the vault in the background", () => {
    expect(h.vaultRecall).toEqual([true]);
    expect(vault().config.folders).toEqual(["People", "Projects", "Daily", "Meetings"]);
    expect(vault().index).not.toBeNull();
  });

  it("cues a known person until the lens has shown the cue, and again in the next conversation", async () => {
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    expect(ws.types()).toEqual(["status", "utterance", "recall", "thinking:1"]);
    const cue = ws.cues()[0]!;
    expect(cue.name).toBe("Sarah Chen");
    expect(cue.facts.length).toBeGreaterThan(0);
    expect(JSON.stringify(cue)).not.toContain("ZEBULON");

    // Not acknowledged: sent again, but never within 20 s.
    later(5_000);
    ws.text({ type: "ask", text: "Hi Sarah, how was the trip?" });
    expect(ws.cues()).toHaveLength(1);
    later(25_000);
    ws.text({ type: "ask", text: "Hi Sarah, how was the trip?" });
    expect(ws.cues()).toHaveLength(2);

    // The lens showed it: not again in this conversation.
    ws.text({ type: "recall_shown", name: cue.name });
    later(25_000);
    ws.text({ type: "ask", text: "Hi Sarah, are you still there?" });
    expect(ws.cues()).toHaveLength(2);

    // A reset from the page starts a new conversation.
    ws.text({ type: "reset" });
    later(25_000);
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    expect(ws.cues()).toHaveLength(3);

    // So does the end of a meeting.
    ws.text({ type: "recall_shown", name: cue.name });
    ws.text({ type: "end_meeting" });
    // endMeeting starts the next conversation (recall.reset) before its first await.
    await until(() => ended >= FakeWs.saves);
    later(25_000);
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    expect(ws.cues()).toHaveLength(4);
  });

  it("never cues a topic, an unknown name or a blocked name", () => {
    const ws = open();
    ws.text({ type: "ask", text: "How is the Atlas migration going?" });
    later(25_000);
    ws.text({ type: "ask", text: "I met Secret Person yesterday." });
    later(25_000);
    ws.text({ type: "ask", text: "Will you send it over?" });
    expect(ws.cues()).toEqual([]);
    expect(streams[0]!.vaultNotes).toContain("Atlas migration");
    for (const stream of streams) expect(stream.vaultNotes ?? "").not.toContain("ZEBULON");
  });

  it("sends the vault block with the request, and keeps a person for later questions", () => {
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    later(10 * 60_000);
    ws.text({ type: "ask", text: "Did you get a chance to send over that deck?" });
    expect(streams).toHaveLength(2);
    for (const stream of streams) {
      const notes = stream.vaultNotes ?? "";
      expect(notes.startsWith("<vault_notes>\n## Sarah Chen (person)\n")).toBe(true);
      expect(notes.endsWith("</vault_notes>")).toBe(true);
      expect(notes.split("</vault_notes>")).toHaveLength(2);
      expect(notes).not.toContain("<transcript>");
      expect(notes).not.toContain("ZEBULON");
      expect(notes.length).toBeLessThanOrEqual(RECALL_CHARS);
    }
  });

  it("sends no block for a line that names nobody", () => {
    const ws = open();
    ws.text({ type: "ask", text: "What do you think about the launch date?" });
    expect(streams[0]!.vaultNotes).toBe("");
  });

  it("refers to the past meeting notes when the meeting is already in them", () => {
    h.pastInclude = true;
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    expect(streams[0]!.vaultNotes).toContain("(in the past meeting notes above)");
  });

  it("lists the quoted notes in the saved meeting note and indexes it at once", async () => {
    vi.useRealTimers();
    const ws = open();
    h.transcript = "Did Sarah send over the deck yet?";
    ws.speech(10);
    ws.text({ type: "end_meeting" });
    await until(() => ws.sent.some((m) => m.type === "status" && m.text.startsWith("Saved")));
    // "Saved" goes out first; the past-meetings reload and then the forced rescan follow.
    await until(() => h.events.at(-1) === "refresh!");
    expect(streams.at(-1)!.vaultNotes).toContain("## Sarah Chen (person)");
    const meetings = join(vaultDir, "Meetings");
    // Other tests save notes with the same title: pick this conversation's note by its line.
    const names = (await readdir(meetings)).filter((n) => n.includes("Saved talk"));
    const texts = await Promise.all(names.map((n) => readFile(join(meetings, n), "utf8")));
    const saved = texts.filter((t) => t.includes(h.transcript));
    expect(saved).toHaveLength(1);
    const note = saved[0]!;
    expect(note).toContain("## Vault notes sent to Claude");
    expect(note).toContain("- [[People/Sarah Chen]]");
    expect(note).not.toContain("ZEBULON");
    expect(h.events.at(-1)).toBe("refresh!");
  });

  it("builds the block before the request and rescans only after an answer has decided", async () => {
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, did you send the deck?" });
    // streamAnswer runs in the same call as the message: nothing on the answer path is awaited.
    expect(h.events).toEqual(["stream"]);
    streams[0]!.handlers.onNone();
    expect(h.events).toEqual(["stream", "refresh"]);
    ws.text({ type: "ask", text: "And where are you based now?" });
    streams[1]!.handlers.onStart();
    streams[1]!.handlers.onDone();
    expect(h.events).toEqual(["stream", "refresh", "stream", "refresh"]);
    // A line that sends no request may rescan (throttled inside the vault).
    vi.useRealTimers();
    h.transcript = "Okay then.";
    ws.speech(10);
    await until(() => ws.sent.some((m) => m.type === "utterance" && m.text === "Okay then."));
    expect(ws.sent).toContainEqual({ type: "utterance", text: "Okay then.", speaker: "other" });
    expect(h.events).toEqual(["stream", "refresh", "stream", "refresh", "refresh"]);
  });

  it("starts the next conversation before the save: a name said while the note is saved is cued and kept", async () => {
    vi.useRealTimers();
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
    ws.text({ type: "recall_shown", name: "Sarah Chen" });
    let release: () => void = () => undefined;
    h.summaryGate = new Promise((resolve) => (release = resolve));
    h.transcript = "Okay, see you next week then.";
    ws.speech(10);
    ws.text({ type: "end_meeting" });
    await until(() => h.summarizing > 0);
    expect(h.summarizing).toBe(1);
    ws.text({ type: "ask", text: "Hi Sarah, one more thing." });
    release();
    await until(() => ws.sent.some((m) => m.type === "status" && m.text.startsWith("Saved")));
    ws.text({ type: "ask", text: "Did you get a chance to send over that deck?" });
    expect(ws.cues()).toHaveLength(2);
    expect(streams.at(-1)!.vaultNotes).toContain("## Sarah Chen (person)");
  });

  it("passes the typed flag to recall: a typed name matches in lower case", () => {
    const ws = open();
    ws.text({ type: "ask", text: "what did sarah say about the deck?" });
    expect(ws.cues().map((c) => c.name)).toEqual(["Sarah Chen"]);
    expect(streams[0]!.vaultNotes).toContain("## Sarah Chen (person)");
  });

  it("observes the wearer's own lines: a name the wearer says is cued and recalled", async () => {
    vi.useRealTimers();
    const ws = open();
    h.transcript = "Hi Sarah, good to see you.";
    ws.speech(10, 1);
    await until(() => ws.sent.some((m) => m.type === "utterance"));
    expect(ws.sent).toContainEqual({ type: "utterance", text: "Hi Sarah, good to see you.", speaker: "self" });
    expect(ws.cues().map((c) => c.name)).toEqual(["Sarah Chen"]);
    expect(streams).toHaveLength(0);
    ws.text({ type: "ask", text: "Did you get a chance to send over that deck?" });
    expect(streams[0]!.vaultNotes).toContain("## Sarah Chen (person)");
  });

  it("answers as usual, without cue or block, when the vault index throws", () => {
    h.throwIndex = true;
    const ws = open();
    ws.text({ type: "ask", text: "Hi Sarah, did you send the deck?" });
    expect(ws.cues()).toEqual([]);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.vaultNotes).toBe("");
    streams[0]!.handlers.onStart();
    streams[0]!.handlers.onDelta("- Yes, this morning.");
    streams[0]!.handlers.onDone();
    expect(ws.types()).toEqual(["status", "utterance", "thinking:1", "answer_start:1", "answer_delta:1", "answer_done:1"]);
  });

  describe("vault graph", () => {
    type Graph = Extract<ServerMessage, { type: "vault_graph" }>;
    const graphs = (ws: FakeWs) => ws.sent.filter((m): m is Graph => m.type === "vault_graph");

    it("sends the graph once to an Answers page, right after connect, and nothing to other pages", () => {
      const ws = open("answers");
      expect(ws.types()).toEqual(["status", "vault_graph"]);
      const graph = graphs(ws)[0]!;
      const titles = graph.nodes.map((n) => n.title);
      expect(titles).toContain("Sarah Chen");
      expect(titles).toContain("Atlas migration");
      for (const bad of ["Secret", "Diary", "Journal", "Josh"]) expect(titles.join("|")).not.toContain(bad);
      expect(JSON.stringify(graph)).not.toContain("ZEBULON");
      for (const app of [null, "around", "sky"]) {
        const other = open(app);
        expect(other.types()).toEqual(["status"]);
      }
    });

    it("sends a new graph after a rescan only when it changed", async () => {
      const ws = open("answers");
      // A forced scan under the fake clock puts the vault's last scan at "now", so the jump below passes its throttle.
      await vault().refresh(true);
      const file = join(vaultDir, "People", "Zed Quill.md");
      await writeFile(file, "A new person.\n");
      try {
        later(2 * 3_600_000); // past any rescan throttle left by earlier tests
        ws.text({ type: "ask", text: "And where are you based now?" });
        streams[0]!.handlers.onNone();
        await until(() => graphs(ws).some((g) => g.nodes.some((n) => n.title === "Zed Quill")));
        // No graph repeats the one before it: a rescan that changed nothing sends nothing.
        const all = graphs(ws).map((g) => JSON.stringify(g));
        all.forEach((g, i) => i > 0 && expect(g).not.toBe(all[i - 1]));
        expect(graphs(ws).length).toBeGreaterThan(1);
      } finally {
        await rm(file, { force: true });
        await vault().refresh(true);
      }
    });

    it("adds the node id to the cue of a person in the graph", () => {
      const ws = open("answers");
      ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
      const graph = graphs(ws)[0]!;
      const sarah = graph.nodes.find((n) => n.title === "Sarah Chen")!;
      expect(ws.cues()[0]!.id).toBe(sarah.id);
      expect(graph.total).toEqual({ notes: expect.any(Number), people: 8 });
      expect(ws.cues()[0]!.card).toMatchObject({ met: 1, seen: "12 Nov", open: "Send the deck" });
      expect(ws.cues()[0]!.facts[0]).toBe("12 Nov  ·  Pricing plan with Sarah");
      // Other pages get the cue as before, with no id.
      const plain = open();
      plain.text({ type: "ask", text: "Hi Sarah, good to see you." });
      expect(plain.cues()[0]).not.toHaveProperty("id");
    });

    it("leaves the id out when the person is not a node of the graph sent", () => {
      const ws = open("answers");
      ws.text({ type: "ask", text: "Hi Sarah, good to see you." });
      expect(ws.cues()[0]!.id).toBeTypeOf("number");
      // A connection that has no graph (index unreadable at connect) has no id.
      h.throwIndex = true;
      const bare = open("answers");
      h.throwIndex = false;
      expect(graphs(bare)).toHaveLength(0);
      bare.text({ type: "ask", text: "Hi Sarah, good to see you." });
      expect(bare.cues()[0]).not.toHaveProperty("id");
    });

    it("lists in answer_start the titles of the notes quoted, as in the saved meeting note", async () => {
      vi.useRealTimers();
      const ws = open("answers");
      h.transcript = "Did Sarah send over the deck yet?";
      ws.speech(10);
      ws.text({ type: "end_meeting" });
      await until(() => streams.length > 0);
      streams.at(-1)!.handlers.onStart();
      const start = ws.sent.find((m) => m.type === "answer_start");
      expect(start).toBeDefined();
      const notes = (start as { notes?: string[] }).notes;
      expect(notes).toContain("Sarah Chen");
      expect(notes!.length).toBeLessThanOrEqual(6);
      for (const title of notes!) expect(title.length).toBeLessThanOrEqual(40);

      await until(() => ws.sent.some((m) => m.type === "status" && m.text.startsWith("Saved")));
      const meetings = join(vaultDir, "Meetings");
      const names = (await readdir(meetings)).filter((n) => n.includes("Saved talk"));
      const texts = await Promise.all(names.map((n) => readFile(join(meetings, n), "utf8")));
      const note = texts.find((t) => t.includes(h.transcript))!;
      const audit = [...note.matchAll(/^- \[\[(.+)\]\]$/gm)].map((m) => m[1]!).filter((p) => p.includes("/"));
      const expected = audit.map((path) =>
        nodeTitle({ kind: path.startsWith("Meetings/") ? "meeting" : "note", title: path.split("/").pop()! }),
      );
      expect(notes).toEqual([...new Set(expected)]);
    });

    it("leaves notes out of answer_start when nothing was quoted", () => {
      const ws = open("answers");
      ws.text({ type: "ask", text: "What do you think about the launch date?" });
      streams[0]!.handlers.onStart();
      const start = ws.sent.find((m) => m.type === "answer_start")!;
      expect(start).not.toHaveProperty("notes");
    });

    it("leaves a title that names a blocked note out of answer_start.notes, as the graph does", async () => {
      const people = join(vaultDir, "People");
      const meetings = join(vaultDir, "Meetings");
      const files = [
        join(people, "Wanda Frost.md"),
        join(people, "Tom Reyes.md"),
        join(meetings, "2026-11-20 14-00 Call with Wanda Frost.md"),
      ];
      await writeFile(files[0]!, "---\nrecall: false\n---\nPrivate.\n");
      await writeFile(files[1]!, "Tom runs ops.\n");
      await writeFile(files[2]!, "---\ntags: [meeting]\npeople: [Tom Reyes]\n---\n# Call with Wanda Frost\n\n## Summary\n\nTom agreed to the plan.\n");
      try {
        await vault().refresh(true);
        const ws = open("answers");
        ws.text({ type: "ask", text: "What did Tom Reyes decide about the plan?" });
        expect(streams[0]!.vaultNotes).toContain("Tom Reyes");
        streams[0]!.handlers.onStart();
        const start = ws.sent.find((m) => m.type === "answer_start") as { notes?: string[] };
        expect(start.notes).toContain("Tom Reyes");
        expect(JSON.stringify(start)).not.toContain("Wanda");
        expect(JSON.stringify(graphs(ws))).not.toContain("Wanda");
      } finally {
        for (const f of files) await rm(f, { force: true });
        await vault().refresh(true);
      }
    });

    it("sends no graph and still answers when the vault index throws", () => {
      h.throwIndex = true;
      const ws = open("answers");
      ws.text({ type: "ask", text: "Hi Sarah, did you send the deck?" });
      streams[0]!.handlers.onStart();
      streams[0]!.handlers.onDelta("- Yes.");
      streams[0]!.handlers.onDone();
      expect(ws.types()).toEqual(["status", "utterance", "thinking:1", "answer_start:1", "answer_delta:1", "answer_done:1"]);
    });
  });
});
