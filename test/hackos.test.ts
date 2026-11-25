import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { CAP_NOTE, DISCARD_NOTE, HackBrain, HackSession, MAX_RECORDING_MS, MAX_TURNS, answerStats, buildMessages, mayBeWaking, parseSse } from "../server/hackos";
import { speakerCode, type HackView } from "../src/core/protocol";
import { NEW_CHAT_GRACE_MS, doubleTapAction, hackScreen } from "../src/hackos/view";

// server/hackos.ts reads these when it loads. A dummy key keeps the Keychain out of the tests.
const env = vi.hoisted(() => {
  const saved = { url: process.env.HACKOS_URL, key: process.env.HACKOS_API_KEY, level: process.env.LOG_LEVEL };
  process.env.HACKOS_URL = "http://model.test/v1";
  process.env.HACKOS_API_KEY = "test-key";
  process.env.LOG_LEVEL = "error"; // the failure tests log warnings on purpose
  return saved;
});
afterAll(() => {
  if (env.level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = env.level;
  if (env.url === undefined) delete process.env.HACKOS_URL;
  else process.env.HACKOS_URL = env.url;
  if (env.key === undefined) delete process.env.HACKOS_API_KEY;
  else process.env.HACKOS_API_KEY = env.key;
});

const now = new Date(2026, 10, 23, 14, 0, 30);
const base: HackView = { state: "idle", model: "qwen3.8-27b", prompt: "", answer: "", stats: "", error: "", startedAt: null, history: [] };
const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

describe("event stream", () => {
  it("collects the text of complete lines and keeps the unfinished tail", () => {
    const half = chunk("lin");
    const parsed = parseSse(chunk("Ber") + half.slice(0, 20));
    expect(parsed.deltas).toEqual(["Ber"]);
    expect(parsed.done).toBe(false);
    expect(parseSse(parsed.rest + half.slice(20)).deltas).toEqual(["lin"]);
  });
  it("stops at [DONE] and skips lines it does not know", () => {
    const parsed = parseSse(`: keep-alive\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\ndata: not json\n${chunk("ok")}data: [DONE]\n`);
    expect(parsed.deltas).toEqual(["ok"]);
    expect(parsed.done).toBe(true);
  });
});

describe("request messages", () => {
  it("sends the system prompt, the kept turns in order, then the new message", () => {
    const messages = buildMessages([{ prompt: "hi", answer: "hello" }], "and now?", now, "Josh");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[0]?.content).toContain("Josh");
    expect(messages.at(-1)?.content).toBe("and now?");
  });
  it("keeps only the newest turns", () => {
    const history = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ prompt: `q${i}`, answer: `a${i}` }));
    const messages = buildMessages(history, "last", now);
    expect(messages).toHaveLength(MAX_TURNS * 2 + 2);
    expect(messages[1]?.content).toBe("q5");
  });
});

describe("stats", () => {
  it("counts words and whole seconds", () => {
    expect(answerStats("Berlin is the capital.", 2400)).toBe("4 words  ·  2s");
    expect(answerStats("Yes", 200)).toBe("1 word  ·  1s");
  });
});

describe("HackOS screen", () => {
  it("invites you to hold and talk when idle", () => {
    const s = hackScreen(base, 0, now);
    expect(s.status.content).toBe("HACKOS  ·  qwen3.8-27b");
    expect(s.card.content).toContain("Hold and speak");
    expect(s.sigil).toBe("paused");
  });
  it("says the GPU is waking, with the elapsed time", () => {
    const s = hackScreen({ ...base, state: "waking", prompt: "what time is it", startedAt: now.getTime() - 21_000 }, 0, now);
    expect(s.status.content).toBe("WAKING THE GPU  ·  21s");
    expect(s.question.content).toBe("“what time is it”");
    expect(s.sigil).toBe("thinking");
  });
  it("follows the newest page while the answer streams, with a caret", () => {
    const answer = Array.from({ length: 9 }, (_, i) => `- point ${i}`).join("\n");
    const s = hackScreen({ ...base, state: "answering", prompt: "list", answer }, 0, now);
    expect(s.pageCount).toBe(2);
    expect(s.page).toBe(1);
    expect(s.status.content).toBe("ANSWER  ·  2/2");
    expect(s.card.content.endsWith("│")).toBe(true);
  });
  it("pages a finished answer and shows the stats", () => {
    const answer = Array.from({ length: 14 }, (_, i) => `- point ${i}`).join("\n");
    const s = hackScreen({ ...base, state: "done", prompt: "list", answer, stats: "42 words  ·  3s" }, 1, now);
    expect(s.status.content).toBe("HACKOS  ·  42 words  ·  3s  ·  2/3");
    expect(s.card.content.startsWith("• point 6")).toBe(true);
  });
  it("shows setup and request errors in the card", () => {
    expect(hackScreen({ ...base, state: "off", error: "Set HACKOS_URL in .env." }, 0, now).status.content).toBe("HACKOS  ·  SETUP");
    const s = hackScreen({ ...base, state: "error", error: "The GPU did not start." }, 0, now);
    expect(s.status.content).toBe("CHECK");
    expect(s.card.content).toBe("The GPU did not start.");
  });
  it("keeps a note such as a missed recording next to the hint", () => {
    expect(hackScreen({ ...base, error: "Didn't catch that. Hold and speak again." }, 0, now).card.content).toContain("Didn't catch that");
  });
  it("shows a note from a failed recording above an old answer, on every page", () => {
    const answer = Array.from({ length: 14 }, (_, i) => `- point ${i}`).join("\n");
    const note = "Speech-to-text is not running. Start everything with npm run dev.";
    const s = hackScreen({ ...base, state: "done", prompt: "list", answer, stats: "42 words  ·  3s", error: note }, 1, now);
    expect(s.question.content.replace("\n", " ")).toBe(note);
    expect(s.card.content.startsWith("• point 6")).toBe(true);
    expect(s.status.content).toBe("HACKOS  ·  42 words  ·  3s  ·  2/3");
    expect(hackScreen({ ...base, state: "done", prompt: "list", answer }, 0, now).question.content).toBe("“list”");
  });
  it("shows a note from the page itself: a missing pairing key, or a microphone that did not open", () => {
    const key = "No pairing key in the page URL. Open the app with npm run qr or npm run sim.";
    const off = hackScreen(null, 0, now, key);
    expect(off.status.content).toBe("CHECK");
    expect(off.card.content.replace("\n", " ")).toBe(key);
    expect(hackScreen(null, 0, now).status.content).toBe("CONNECTING");
    const mic = hackScreen({ ...base, state: "done", prompt: "hi", answer: "Hello." }, 0, now, "The glasses microphone did not start. Reopen HackOS.");
    expect(mic.question.content).toBe("The glasses microphone did not start. Reopen HackOS.");
    expect(mic.card.content).toBe("Hello.");
  });
});

describe("HackOS double tap", () => {
  const at = 1_000_000;
  it("stops an answer and cancels speech that is being transcribed", () => {
    for (const state of ["transcribing", "waking", "thinking", "answering"] as const) {
      expect(doubleTapAction({ ...base, state }, 0, at)).toBe("hack_stop");
    }
  });
  it("starts a new chat only when the answer ended some time ago", () => {
    const done: HackView = { ...base, state: "done", answer: "Paris." };
    expect(doubleTapAction(done, at - 100, at)).toBeNull();
    expect(doubleTapAction(done, at - NEW_CHAT_GRACE_MS, at)).toBe("hack_new");
    expect(doubleTapAction({ ...base, state: "idle" }, 0, at)).toBe("hack_new");
    expect(doubleTapAction(null, 0, at)).toBeNull();
  });
});

// ---- HackBrain against a stand-in model server (fetch is replaced; timers are fake) ----

const enc = new TextEncoder();
type Part = { at: number; text: string };

/** A streaming reply: each part at its time (ms after the reply), then the end unless `end` is false. */
function streamReply(parts: Part[], init: RequestInit | undefined, end = true): Response {
  const signal = init?.signal ?? undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) timers.push(setTimeout(() => controller.enqueue(enc.encode(p.text)), p.at));
      if (end) timers.push(setTimeout(() => controller.close(), Math.max(0, ...parts.map((p) => p.at)) + 1));
      signal?.addEventListener("abort", () => {
        timers.forEach(clearTimeout);
        controller.error(signal.reason);
      }, { once: true });
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Resolves after `ms` (fake time), or rejects when the request is aborted. */
function after<T>(ms: number, init: RequestInit | undefined, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value()), ms);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal?.reason);
    }, { once: true });
  });
}

const unterminated = (text: string) => chunk(text).trimEnd();
const authOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>).authorization;

describe("HackBrain", () => {
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout ignores fake timers; route it through them, so a timeout on the fetch signal would fire here too.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return c.signal;
    });
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lets a long answer finish after a slow GPU start (the 100 s limit covers the wait only)", async () => {
    const words = Array.from({ length: 60 }, (_, i) => ({ at: i * 1000, text: chunk(`w${i} `) }));
    fetchMock.mockImplementation((_url, init) => after(70_000, init, () => streamReply([...words, { at: 60_000, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("explain");
    await vi.advanceTimersByTimeAsync(135_000);
    await run;
    expect(brain.view.state).toBe("done");
    expect(brain.view.answer.trim().split(" ")).toHaveLength(60);
    expect(brain.view.history).toHaveLength(1);
  });

  it("reports a stream that stops sending as stalled, with a true message", async () => {
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([{ at: 10, text: chunk("Hello") }], init, false)));
    const brain = new HackBrain();
    const run = brain.run("hi");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(brain.view.state).toBe("answering");
    await vi.advanceTimersByTimeAsync(100_000);
    await run;
    expect(brain.view.state).toBe("error");
    expect(brain.view.error).toBe("The model stopped answering part way. Ask again.");
    expect(brain.view.history).toHaveLength(0);
  });

  it("keeps the last line of a stream that ends without a newline", async () => {
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([{ at: 0, text: chunk("Hello") + unterminated(" world") }], init)));
    const brain = new HackBrain();
    const run = brain.run("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(brain.view.state).toBe("done");
    expect(brain.view.answer).toBe("Hello world");
  });

  it("says the server cannot be reached at once when the connection is refused", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) }));
    const brain = new HackBrain();
    const run = brain.run("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(brain.view.state).toBe("error");
    expect(brain.view.error).toBe("The model server could not be reached. Check the network and HACKOS_URL.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await run;
  });

  it("still waits for a GPU that drops the first connections while it starts", async () => {
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    fetchMock
      .mockRejectedValueOnce(reset)
      .mockRejectedValueOnce(reset)
      .mockImplementation((_url, init) => Promise.resolve(streamReply([{ at: 0, text: chunk("awake") + "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("hi");
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(brain.view.state).toBe("done");
    expect(brain.view.answer).toBe("awake");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the API key again after the server rejects it", async () => {
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(authOf(init) === "Bearer new-key" ? streamReply([{ at: 0, text: chunk("ok") + "data: [DONE]\n\n" }], init) : new Response("bad key", { status: 401 })),
    );
    const brain = new HackBrain();
    process.env.HACKOS_API_KEY = "old-key";
    const first = brain.run("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(brain.view.error).toContain("rejected the API key");
    process.env.HACKOS_API_KEY = "new-key"; // the user fixes the key while the server runs
    const second = brain.run("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(authOf(fetchMock.mock.calls.at(-1)?.[1])).toBe("Bearer new-key");
    expect(brain.view.state).toBe("done");
    process.env.HACKOS_API_KEY = "test-key";
  });
});

describe("network errors that a starting GPU can cause", () => {
  const failed = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  it("retries timeouts and dropped connections, not a wrong address", () => {
    expect(mayBeWaking(new DOMException("timeout", "TimeoutError"))).toBe(true);
    expect(mayBeWaking(failed("ECONNRESET"))).toBe(true);
    expect(mayBeWaking(failed("ECONNREFUSED"))).toBe(false);
    expect(mayBeWaking(failed("ENOTFOUND"))).toBe(false);
    expect(mayBeWaking(new TypeError("Failed to parse URL", { cause: Object.assign(new Error("bad"), { code: "ERR_INVALID_URL" }) }))).toBe(false);
    expect(mayBeWaking(new TypeError("fetch failed", { cause: new Error("unknown scheme") }))).toBe(false);
  });
});

// ---- HackSession on stand-in sockets (real timers; fetch is replaced) ----

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  views: HackView[] = [];
  send(data: string): void {
    const message = JSON.parse(data) as { type: string; data: HackView };
    if (message.type === "hack") this.views.push(message.data);
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
  get last(): HackView | undefined {
    return this.views.at(-1);
  }
}

describe("HackSession", () => {
  let transcript: ((text: string) => void) | null = null;
  const modelPrompts: string[] = [];
  /** Size of each WAV sent to speech-to-text. */
  const heard: number[] = [];
  const answerSpeech = (text: string) => transcript?.(text);
  const connect = () => {
    const ws = new FakeSocket();
    new HackSession(ws as unknown as WebSocket);
    return ws;
  };
  beforeEach(() => {
    modelPrompts.length = 0;
    heard.length = 0;
    transcript = null;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("http://model.test")) {
        heard.push(((init?.body as FormData).get("file") as Blob).size);
        // Speech-to-text: answer when the test says so.
        return new Promise<Response>((resolve) => {
          transcript = (text) => resolve(Response.json({ text }));
        });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      modelPrompts.push(body.messages.at(-1)?.content ?? "");
      return Promise.resolve(streamReply([{ at: 0, text: chunk("ok") + "data: [DONE]\n\n" }], init));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ends a hold when its connection closes, so the shared view leaves recording", () => {
    const glasses = connect();
    const mac = connect();
    mac.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    expect(mac.last?.state).toBe("recording");
    glasses.emit("close");
    expect(mac.last?.state).toBe("idle");
    expect(mac.last?.error).toBe(DISCARD_NOTE);
  });

  it("keeps a newer hold from another connection when an old connection closes late", () => {
    const old = connect();
    const fresh = connect();
    fresh.say({ type: "hack_new" });
    old.say({ type: "hack_ptt", on: true });
    fresh.say({ type: "hack_ptt", on: true });
    old.emit("close");
    expect(fresh.last?.state).toBe("recording");
    fresh.emit("close");
    expect(connect().last?.state).toBe("idle");
  });

  it("sends the transcribed speech to the model", async () => {
    const glasses = connect();
    glasses.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(1000);
    glasses.say({ type: "hack_ptt", on: false });
    await vi.waitFor(() => expect(transcript).not.toBeNull());
    answerSpeech("what time is it");
    await vi.waitFor(() => expect(glasses.last?.state).toBe("done"));
    expect(modelPrompts).toEqual(["what time is it"]);
  });

  it("drops speech that is being transcribed when the wearer stops", async () => {
    transcript = null;
    const glasses = connect();
    glasses.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(1000);
    glasses.say({ type: "hack_ptt", on: false });
    expect(glasses.last?.state).toBe("transcribing");
    await vi.waitFor(() => expect(transcript).not.toBeNull());
    glasses.say({ type: "hack_stop" });
    answerSpeech("delete the build folder");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modelPrompts).toEqual([]);
    expect(glasses.last?.state).toBe("idle");
    expect(glasses.last?.error).toBe("Cancelled.");
  });

  it("drops a hold that the page ended with discard, and sends nothing", async () => {
    const glasses = connect();
    glasses.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(3000);
    glasses.say({ type: "hack_ptt", on: false, discard: true });
    expect(glasses.last).toMatchObject({ state: "idle", error: DISCARD_NOTE });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Whatever was transcribed during the hold is not sent; a late release runs nothing.
    answerSpeech("the parcel arrives on thursday");
    glasses.say({ type: "hack_ptt", on: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modelPrompts).toEqual([]);
    expect(glasses.last?.state).toBe("idle");
  });

  it("drops a recording whose release never comes, after MAX_RECORDING_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const glasses = connect();
      glasses.say({ type: "hack_new" });
      glasses.say({ type: "hack_ptt", on: true });
      glasses.speak(1000);
      vi.advanceTimersByTime(MAX_RECORDING_MS);
      expect(glasses.last).toMatchObject({ state: "idle", error: CAP_NOTE });
      glasses.speak(1000); // frames after the limit are ignored
      glasses.say({ type: "hack_ptt", on: false }); // the late release
      await vi.advanceTimersByTimeAsync(100);
      expect(heard).toEqual([]);
      expect(modelPrompts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a press while the last hold is still transcribed, so neither message is lost", async () => {
    const glasses = connect();
    glasses.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(1000);
    glasses.say({ type: "hack_ptt", on: false });
    await vi.waitFor(() => expect(transcript).not.toBeNull());
    glasses.say({ type: "hack_ptt", on: true });
    expect(glasses.last?.state).toBe("transcribing");
    glasses.speak(1000);
    glasses.say({ type: "hack_ptt", on: false });
    answerSpeech("first message");
    await vi.waitFor(() => expect(glasses.last?.state).toBe("done"));
    expect(modelPrompts).toEqual(["first message"]);
    expect(heard).toHaveLength(1);
  });

  it("starts over on a second press: only the speech after it is sent", async () => {
    const glasses = connect();
    glasses.say({ type: "hack_new" });
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(1000); // the release of this hold was lost
    glasses.say({ type: "hack_ptt", on: true });
    glasses.speak(1000);
    glasses.say({ type: "hack_ptt", on: false });
    await vi.waitFor(() => expect(transcript).not.toBeNull());
    answerSpeech("what time is it");
    await vi.waitFor(() => expect(glasses.last?.state).toBe("done"));
    expect(modelPrompts).toEqual(["what time is it"]);
    // One second of speech (plus the WAV header and pre-roll), not two.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeLessThan(1500 * 32);
  });
});
