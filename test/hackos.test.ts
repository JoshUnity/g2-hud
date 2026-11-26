import { EventEmitter } from "node:events";
import { ImageRawDataUpdateResult, OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { CAP_NOTE, DISCARD_NOTE, HackBrain, HackSession, MAX_RECORDING_MS, MAX_TURNS, RATE_SAMPLES, answerStats, buildMessages, mayBeWaking, parseSse } from "../server/hackos";
import { sameFrame } from "../src/core/pixels";
import { calibrate } from "../src/core/calibrate";
import { speakerCode, type HackView } from "../src/core/protocol";
import { textWidth } from "../src/core/text";
import { DEMO_SCENES, demoScreen, demoView } from "../src/hackos/demo";
import { ICON } from "../src/hackos/icon";
import { BOOT_MS, EDGES, VERTICES, bootParam, hackFps, iconFrame, renderHack, voiceStep } from "../src/hackos/render";
import { NEW_CHAT_GRACE_MS, bootScreen, doubleTapAction, hackScreen, footerOf, microFits, screenTexts, speedOf, type HackMode, type HackScreen } from "../src/hackos/view";

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
  it("shows the generation time and the backend's own token count", () => {
    expect(answerStats(2100, 96)).toBe("2.1 s  ·  96 tokens");
    expect(answerStats(0, 1)).toBe("0.0 s  ·  1 token");
    // No count from the backend: the time only. Words are never shown as tokens.
    expect(answerStats(2400, null)).toBe("2.4 s");
  });
});

describe("HackOS screen", () => {
  const answer14 = Array.from({ length: 14 }, (_, i) => `- point ${i}`).join("\n");
  const texts = (v: HackView | null, p = 0, notice = "") => screenTexts(hackScreen(v, p, now, notice));
  it("invites you to hold and talk when idle, with the hint at the board's place (0, 255)", () => {
    const s = hackScreen(base, 0, now);
    expect(s.status).toEqual({ content: "HackOS", color: 3 });
    expect(s.mode).toBe("idle");
    expect(s.layout).toBe("answer");
    expect(texts(base)).toEqual([
      { text: "HackOS", x: 32, y: 0, level: 3 },
      { text: "Hold talk  ·  Double tap new chat", x: 0, y: 255, level: 1 },
    ]);
    // The footer would draw over the hint at y 276, so a screen with the hint has none.
    expect(s.footer).toBe("");
  });
  it("puts the status at (32, 0), the prompt at (0, 36) and the answer from (0, 72), as the board", () => {
    const view: HackView = { ...base, state: "done", prompt: "Give me three names for a sailing club", answer: "• Windward Club\n• The Slack Tide Society", stats: "2.1 s  ·  96 tokens" };
    expect(texts(view)).toEqual([
      { text: "HackOS", x: 32, y: 0, level: 3 },
      { text: "“Give me three names for a sailing club”", x: 0, y: 36, level: 2 },
      { text: "• Windward Club", x: 0, y: 72, level: 4 },
      { text: "• The Slack Tide Society", x: 0, y: 99, level: 4 },
    ]);
    expect(hackScreen(view, 0, now).footer).toBe("2.1 s  ·  96 tokens  ·  qwen3.8-27b");
  });
  it("says the GPU is waking: the sentence at (222, 176), the counter's seconds, the waking layout", () => {
    const s = hackScreen({ ...base, state: "waking", prompt: "what time is it", startedAt: now.getTime() - 21_000 }, 0, now);
    expect(s.status.content).toBe("Waking the GPU");
    expect(s.layout).toBe("waking");
    expect(s.mode).toBe("waking");
    expect(s.seconds).toBe(21);
    expect(screenTexts(s)).toContainEqual({ text: "The first answer takes about a minute.", x: 222, y: 176, level: 2 });
    expect(textWidth("The first answer takes about a minute.")).toBeLessThanOrEqual(354);
  });
  it("shows the elapsed time while thinking", () => {
    const s = hackScreen({ ...base, state: "thinking", prompt: "hi", startedAt: now.getTime() - 4_000 }, 0, now);
    expect(s.status.content).toBe("Thinking  ·  4s");
    expect(s.mode).toBe("working");
    expect(hackScreen({ ...base, state: "transcribing" }, 0, now).status.content).toBe("Transcribing");
    expect(hackScreen({ ...base, state: "recording" }, 0, now).status.content).toBe("Listening  ·  release to send");
    expect(hackScreen({ ...base, state: "recording" }, 0, now).mode).toBe("recording");
  });
  it("follows the newest page while the answer streams, with a caret", () => {
    const s = hackScreen({ ...base, state: "answering", prompt: "list", answer: answer14 }, 0, now);
    expect(s.pageCount).toBe(2);
    expect(s.page).toBe(1);
    expect(s.status.content).toBe("HackOS  ·  2/2");
    expect(s.body.content.endsWith("│")).toBe(true);
    expect(s.mode).toBe("answering");
  });
  it("pages a finished answer at 7 lines", () => {
    const answer = Array.from({ length: 20 }, (_, i) => `- point ${i}`).join("\n");
    const s = hackScreen({ ...base, state: "done", prompt: "list", answer, stats: "42 words  ·  3s" }, 1, now);
    expect(s.status.content).toBe("HackOS  ·  2/3");
    expect(s.body.content.startsWith("• point 7")).toBe(true);
    expect(s.body.content.split("\n")).toHaveLength(7);
    expect(s.footer).toBe("42 words  ·  3s  ·  qwen3.8-27b");
  });
  it("wraps every body line inside 400 px, so it never runs under the core", () => {
    const answer = "This is a long sentence that has to wrap across several lines on the glasses because it is longer than the body. ".repeat(6);
    for (const page of [0, 1, 2]) {
      const s = hackScreen({ ...base, state: "done", prompt: "q", answer }, page, now);
      for (const line of s.body.content.split("\n")) expect(textWidth(line)).toBeLessThanOrEqual(400);
    }
  });
  it("keeps the prompt to one line and the body to 7 lines, so nothing runs into the footer at y 276", () => {
    const long = "word ".repeat(80).trim();
    const s = hackScreen({ ...base, state: "done", prompt: long, answer: long.repeat(10) }, 0, now);
    expect(s.prompt.content.split("\n")).toHaveLength(1);
    expect(s.body.content.split("\n")).toHaveLength(7);
  });
  it("shows setup and request errors in the body at brightness 3", () => {
    const setup = hackScreen({ ...base, state: "off", error: "Set HACKOS_URL in .env." }, 0, now);
    expect(setup.status.content).toBe("HackOS  ·  setup");
    expect(setup.body).toEqual({ content: "Set HACKOS_URL in .env.", color: 3 });
    expect(setup.mode).toBe("off");
    const s = hackScreen({ ...base, state: "error", error: "The GPU did not start." }, 0, now);
    expect(s.status.content).toBe("Check");
    expect(s.body.content).toBe("The GPU did not start.");
    expect(s.mode).toBe("off");
  });
  it("keeps a note such as a missed recording next to the hint", () => {
    const s = hackScreen({ ...base, error: "Didn't catch that. Hold and speak again." }, 0, now);
    expect(s.body.content).toContain("Didn't catch that");
    expect(s.hint.content).toBe("Hold talk  ·  Double tap new chat");
  });
  it("shows a note from a failed recording above an old answer, on every page", () => {
    const note = "Speech-to-text is not running. Start everything with npm run dev.";
    const s = hackScreen({ ...base, state: "done", prompt: "list", answer: answer14, stats: "42 words  ·  3s", error: note }, 1, now);
    expect(s.prompt.content).toBe(note);
    expect(s.body.content.startsWith("• point 7")).toBe(true);
    expect(s.status.content).toBe("HackOS  ·  2/2");
    expect(hackScreen({ ...base, state: "done", prompt: "list", answer: answer14 }, 0, now).prompt.content).toBe("“list”");
  });
  it("shows a note from the page itself: a missing pairing key, or a microphone that did not open", () => {
    const key = "No pairing key in the page URL. Open the app with npm run qr or npm run sim.";
    const off = hackScreen(null, 0, now, key);
    expect(off.status.content).toBe("Check");
    expect(off.body.content.replace(/\n/g, " ").trim()).toBe(key);
    expect(hackScreen(null, 0, now).status.content).toBe("Connecting");
    const mic = hackScreen({ ...base, state: "done", prompt: "hi", answer: "Hello." }, 0, now, "The glasses microphone did not start. Reopen HackOS.");
    expect(mic.prompt.content).toBe("The glasses microphone did not start. Reopen HackOS.");
    expect(mic.body.content).toBe("Hello.");
  });
  it("draws the speed bars and the TOK/S text only when the server sent samples", () => {
    const view: HackView = { ...base, state: "done", prompt: "q", answer: "A.", rate: [10, 20, 40] };
    const s = hackScreen(view, 0, now);
    expect(s.speed).toBe("23 TOK/S");
    expect(s.bars).toEqual([4, 7, 11]);
    expect(hackScreen({ ...view, rate: undefined }, 0, now).bars).toBeNull();
    expect(hackScreen({ ...view, rate: [] }, 0, now).speed).toBeNull();
    expect(speedOf([0, 0])).toBeNull();
  });
  it("shows the footer parts whole or not at all, never changed", () => {
    expect(microFits("qwen3.8-27b")).toBe(true);
    expect(microFits("qwen3_8?")).toBe(false);
    expect(footerOf("2.1 s  ·  96 tokens", "qwen3_8")).toBe("2.1 s  ·  96 tokens");
    expect(footerOf("", "qwen3.8-27b")).toBe("qwen3.8-27b");
  });
  it("counts whole seconds elapsed, rounding down", () => {
    const s = hackScreen({ ...base, state: "thinking", prompt: "q", startedAt: now.getTime() - 4_900 }, 0, now);
    expect(s.status.content).toBe("Thinking  ·  4s");
    expect(hackScreen({ ...base, state: "waking", prompt: "q", startedAt: now.getTime() - 4_900 }, 0, now).seconds).toBe(4);
  });
  it("shows only the label and the hint while the core boots", () => {
    const s = bootScreen(hackScreen({ ...base, state: "done", prompt: "q", answer: "A." }, 0, now));
    expect(screenTexts(s)).toEqual([
      { text: "HackOS", x: 32, y: 0, level: 3 },
      { text: "Hold talk  ·  Double tap new chat", x: 0, y: 255, level: 1 },
    ]);
  });
});

describe("HackOS demo scenes", () => {
  it("has a view for every scene, and none for an unknown name", () => {
    expect(DEMO_SCENES.sort()).toEqual(["answering", "done", "error", "idle", "long", "recording", "setup", "thinking", "transcribing", "waking"]);
    for (const scene of DEMO_SCENES) expect(demoView(scene)).not.toBeNull();
    expect(demoView("nope")).toBeNull();
  });
  it("makes the long scene several pages", () => {
    const view = demoView("long");
    expect(view && hackScreen(view, 0, now).pageCount).toBeGreaterThanOrEqual(3);
  });
  it("starts waking and thinking at a time before now", () => {
    expect(demoView("waking", 100_000)?.startedAt).toBeLessThan(100_000);
    expect(demoView("thinking", 100_000)?.startedAt).toBeLessThan(100_000);
  });
  it("counts the waking seconds from the start time, as the board's 4 + floor(t) % 50", () => {
    expect([0, 1.5, 49.9, 50].map((t) => demoScreen("waking", t)?.seconds)).toEqual([4, 5, 53, 4]);
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

  /** A chunk that reports the backend's own token count so far, as vLLM does with continuous_usage_stats. */
  const counted = (text: string, tokens: number) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: { completion_tokens: tokens } })}\n\n`;

  it("keeps the demo's stats exactly in the server's format", () => {
    expect(demoView("done")?.stats).toBe(answerStats(2100, 96));
  });

  it("shows the real token count and the generation time (first token to last), not the wait for the GPU", async () => {
    // The GPU takes 10 s to answer; then tokens stream for 2 s; the backend reports 96 tokens in the last chunk.
    const parts: Part[] = [
      { at: 0, text: counted("A ", 1) },
      { at: 1_000, text: counted("B ", 50) },
      { at: 2_000, text: counted("C ", 96) },
      { at: 2_100, text: `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 96 } })}\n\n` },
      { at: 2_200, text: "data: [DONE]\n\n" },
    ];
    fetchMock.mockImplementation((_url, init) => after(10_000, init, () => streamReply(parts, init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(brain.view.stats).toBe("2.0 s  ·  96 tokens");
  });

  it("leaves the token part out when the backend reports no usage", async () => {
    const parts: Part[] = [{ at: 0, text: chunk("A ") }, { at: 1_500, text: chunk("B ") }, { at: 1_600, text: "data: [DONE]\n\n" }];
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply(parts, init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(brain.view.stats).toBe("1.5 s");
  });

  it("counts the wake from the moment the server says waking, not from the question", async () => {
    fetchMock.mockImplementation((_url, init) => after(20_000, init, () => streamReply([{ at: 0, text: chunk("Hi") }, { at: 10, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const asked = Date.now();
    const run = brain.run("hi");
    expect(brain.view.state).toBe("thinking");
    expect(brain.view.startedAt).toBe(asked);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(brain.view.state).toBe("waking");
    expect(brain.view.startedAt).toBeGreaterThanOrEqual(asked + 4_000);
    expect(brain.view.startedAt).toBeLessThan(asked + 5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(brain.view.startedAt).toBeNull();
  });

  it("retries once without continuous_usage_stats when the backend refuses it, and remembers that", async () => {
    const bodies: { stream_options?: Record<string, boolean> }[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream_options?: Record<string, boolean> };
      bodies.push(body);
      if (body.stream_options?.continuous_usage_stats) return Promise.resolve(new Response('{"error":"Unknown field stream_options.continuous_usage_stats"}', { status: 400 }));
      return Promise.resolve(streamReply([{ at: 10, text: chunk("Hi") }, { at: 20, text: "data: [DONE]\n\n" }], init));
    });
    const brain = new HackBrain();
    const first = brain.run("one");
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(brain.view.state).toBe("done");
    expect(bodies.map((b) => b.stream_options)).toEqual([{ include_usage: true, continuous_usage_stats: true }, { include_usage: true }]);
    // The next question goes out without the option at once.
    const second = brain.run("two");
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(bodies.map((b) => b.stream_options).slice(2)).toEqual([{ include_usage: true }]);
  });

  it("does not drop the option for an unrelated 400", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{"error":"bad model"}', { status: 400 })));
    const brain = new HackBrain();
    const run = brain.run("one");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(brain.view.state).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks the backend to report token counts during the stream", async () => {
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([{ at: 10, text: chunk("Hi") }, { at: 20, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { stream_options?: unknown };
    expect(body.stream_options).toEqual({ include_usage: true, continuous_usage_stats: true });
  });

  it("builds the speed samples from the reported token counts, not from chunks", async () => {
    // Five chunks, but the backend's own counts say 5, 10, 20, 30, 40 tokens at 0, 500, 1000, 1500, 2000 ms.
    // The first report is the baseline; the next one a second later gives (20 - 5) / 1 s, then (40 - 20) / 1 s.
    const counts = [5, 10, 20, 30, 40];
    const parts: Part[] = counts.map((n, i) => ({ at: i * 500, text: counted(`w${i} `, n) }));
    parts.push({ at: 2_100, text: "data: [DONE]\n\n" });
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply(parts, init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(brain.view.rate).toEqual([15, 20]);
  });

  it("sends no speed when the backend reports no token counts (chunks are not tokens)", async () => {
    const parts = Array.from({ length: 30 }, (_, i) => ({ at: i * 200, text: chunk(`w${i} `) }));
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([...parts, { at: 6_100, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(brain.view.state).toBe("done");
    expect(brain.view.rate ?? []).toEqual([]);
  });

  it("sends no speed when the count arrives only at the end (Ollama)", async () => {
    const parts = Array.from({ length: 10 }, (_, i) => ({ at: i * 500, text: chunk(`w${i} `) }));
    const last = `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 10 } })}\n\n`;
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([...parts, { at: 5_100, text: last }, { at: 5_200, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(brain.view.rate ?? []).toEqual([]);
  });

  it("keeps at most 22 samples, and a new question starts a new series", async () => {
    // One report a second for 30 s, 10 more tokens each time: every sample is exactly 10 tokens a second.
    const parts = Array.from({ length: 31 }, (_, i) => ({ at: i * 1000, text: counted(`w${i} `, (i + 1) * 10) }));
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([...parts, { at: 31_000, text: "data: [DONE]\n\n" }], init)));
    const brain = new HackBrain();
    const run = brain.run("count");
    await vi.advanceTimersByTimeAsync(40_000);
    await run;
    expect(brain.view.state).toBe("done");
    expect(brain.view.rate).toHaveLength(RATE_SAMPLES);
    expect(brain.view.rate?.every((r) => r === 10)).toBe(true);
    fetchMock.mockImplementation((_url, init) => Promise.resolve(streamReply([{ at: 10, text: chunk("Hi") }, { at: 20, text: "data: [DONE]\n\n" }], init)));
    const second = brain.run("again");
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(brain.view.rate).toEqual([]);
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

// ---- The lens: icon, core, frame rate and page ----

const lit = (pixels: Uint8Array): number => pixels.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
const MODES: HackMode[] = ["off", "idle", "recording", "working", "waking", "answering"];
const screenOf = (state: HackView["state"], extra: Partial<HackView> = {}) => hackScreen({ ...base, state, prompt: "q", answer: state === "done" ? "A." : "", ...extra }, 0, now);

describe("HackOS lens", () => {
  it("is 576 x 288 and lit in every state", () => {
    for (const state of ["idle", "recording", "transcribing", "waking", "thinking", "answering", "done", "error", "off"] as const) {
      const pixels = renderHack(screenOf(state, { startedAt: now.getTime() - 9_000 }), { t: 1.3, clock: "18:16", level: 0.5 });
      expect(pixels).toHaveLength(576 * 288);
      expect(lit(pixels), state).toBeGreaterThan(300);
    }
  });
  it("draws a core at rest the same every time, so a still lens sends nothing", () => {
    for (const mode of ["idle", "off"] as const) {
      const s = { ...screenOf("done"), mode };
      expect(sameFrame(renderHack(s, { t: 2, clock: "18:16" }), renderHack(s, { t: 2, clock: "18:16" }))).toBe(true);
    }
  });
  it("turns the core while it works", () => {
    const s = screenOf("answering");
    expect(sameFrame(renderHack(s, { t: 1, clock: "18:16" }), renderHack(s, { t: 1.8, clock: "18:16" }))).toBe(false);
  });
  it("follows the voice in three flat steps while recording", () => {
    expect([0, 0.1, 0.2, 0.4, 0.5, 1].map(voiceStep)).toEqual([0, 0, 1, 1, 2, 2]);
    const sum = (level: number) => renderHack(screenOf("recording"), { t: 2, clock: "18:16", level }).reduce((n, v) => n + v, 0);
    expect(sum(0)).toBeLessThan(sum(0.3));
    expect(sum(0.3)).toBeLessThan(sum(0.9));
    expect(sum(0.5)).toBe(sum(0.9));
  });
  it("has twelve vertices and thirty edges", () => {
    expect(VERTICES).toHaveLength(12);
    expect(EDGES).toHaveLength(30);
  });
  it("asks for 4 frames a second while the icon or the opening moves, 2 for a turning core, 0 when still", () => {
    const fps = (state: HackView["state"], reveal = 1, spinning = false) => hackFps(screenOf(state), reveal, spinning);
    expect(fps("recording")).toBe(4);
    expect(fps("thinking")).toBe(4);
    expect(fps("waking")).toBe(2);
    expect(fps("answering")).toBe(2);
    expect(fps("done")).toBe(0);
    expect(fps("error")).toBe(0);
    expect(fps("done", 0.5)).toBe(4);
    expect(fps("done", 1, true)).toBe(2);
  });
  it("reads the load parameter", () => {
    expect(bootParam("?load=off")).toEqual({ off: true, frozen: null });
    expect(bootParam("?load=0.2")).toEqual({ off: false, frozen: 0.2 });
    expect(bootParam("?load=7")).toEqual({ off: false, frozen: 1 });
    expect(bootParam("?demo=idle")).toEqual({ off: false, frozen: null });
    expect(BOOT_MS).toBe(2000);
  });
});

describe("HackOS header icon", () => {
  const bar = (grid: readonly string[]) => [5, 6].map((r) => grid[r]?.slice(2, 10)).join("|");
  it("rests as the plain icon in idle and answering", () => {
    expect(iconFrame("idle", 3, 0)).toEqual(ICON);
    expect(iconFrame("answering", 3, 0)).toEqual(ICON);
  });
  it("is all dim with no bar when off", () => {
    const grid = iconFrame("off", 0, 0);
    expect(grid.join("")).not.toContain("#");
    expect(bar(grid)).toBe("........|........");
    expect(grid[0]).toBe("++........++");
  });
  it("grows the two dashes outward with the voice", () => {
    expect(bar(iconFrame("recording", 0, 0))).toBe("++#..#++|++#..#++");
    expect(bar(iconFrame("recording", 0, 0.3))).toBe("+##..##+|+##..##+");
    expect(bar(iconFrame("recording", 0, 0.9))).toBe("###..###|###..###");
  });
  it("marches the dashes along the bar, four steps a second", () => {
    const frames = [0, 0.25, 0.5, 0.75, 1].map((t) => bar(iconFrame("working", t, 0)));
    expect(frames[0]).toBe(".##..##.|.##..##.");
    expect(new Set(frames.slice(0, 4)).size).toBe(4);
    expect(frames[4]).toBe(frames[0]);
  });
  it("fills the bar from left to right and starts again, as the board", () => {
    expect(bar(iconFrame("waking", 0, 0))).toBe("++++++++|++++++++");
    expect(bar(iconFrame("waking", 1.5, 0))).toBe("###+++++|###+++++");
    expect(bar(iconFrame("waking", 4, 0))).toBe("########|########");
    expect(bar(iconFrame("waking", 4.5, 0))).toBe("++++++++|++++++++");
  });
  it("keeps the pillars lit in every mode but off", () => {
    for (const mode of MODES.filter((m) => m !== "off")) for (const t of [0, 0.3, 0.7]) expect(iconFrame(mode, t, 0.5)[0]).toBe(ICON[0]);
  });
});

describe("HackOS page", () => {
  async function boot(search: string) {
    vi.resetModules();
    vi.stubGlobal("location", { search, protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null, addEventListener: () => {} });
    vi.stubGlobal("window", { addEventListener: () => {} });
    const close = vi.fn();
    vi.doMock("../src/core/net", () => ({ connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => false, close }) }));
    let handler: ((event: EvenHubEvent) => void) | null = null;
    const created: { containerTotalNum: number; imageObject: { containerName: string; zOrderIndex?: number }[]; textObject: { containerName: string; isEventCapture: number; zOrderIndex?: number }[] }[] = [];
    const bridge = {
      createStartUpPageContainer: async (spec: (typeof created)[number]) => {
        created.push(spec);
        return StartUpPageCreateResult.success;
      },
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      audioControl: async () => true,
      onEvenHubEvent: (h: (event: EvenHubEvent) => void) => {
        handler = h;
        return () => {};
      },
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/hackos/main");
    await vi.waitFor(() => expect(handler).not.toBeNull());
    return { created, send: (eventType: OsEventTypeList) => handler!({ sysEvent: { eventType } } as EvenHubEvent), close };
  }

  it("builds one page: the four lens tiles behind and five text containers at the board's places", async () => {
    const { created } = await boot("?demo=idle&intro=0");
    const page = created[0];
    expect(page?.containerTotalNum).toBe(9);
    const all = [...(page?.imageObject ?? []), ...(page?.textObject ?? [])] as { containerID: number; containerName: string }[];
    expect(new Set(all.map((c) => c.containerID)).size).toBe(9);
    expect(new Set(all.map((c) => c.containerName)).size).toBe(9);
    expect(page?.imageObject.map((c) => c.containerName)).toEqual(["t00", "t10", "t01", "t11"]);
    expect(page?.textObject.map((c) => c.containerName)).toEqual(["status", "prompt", "body", "sentence", "hint"]);
    expect(page?.textObject.filter((c) => c.isEventCapture === 1).map((c) => c.containerName)).toEqual(["body"]);
    // Every container sets zOrderIndex, with unique values, images behind and text in front.
    const z = all.map((c) => (c as { zOrderIndex?: number }).zOrderIndex);
    expect(z.every((v) => typeof v === "number")).toBe(true);
    expect(new Set(z).size).toBe(9);
    expect(Math.max(...(page?.imageObject ?? []).map((c) => c.zOrderIndex ?? 0))).toBeLessThan(Math.min(...(page?.textObject ?? []).map((c) => c.zOrderIndex ?? 0)));
  });
  it("closes the connection on a system exit", async () => {
    const { send, close } = await boot("?k=key&intro=0");
    send(OsEventTypeList.SYSTEM_EXIT_EVENT);
    expect(close).toHaveBeenCalled();
  });
});


describe("HackOS page, live (no demo scene)", () => {
  /** Boots the real main.ts against a fake host and a fake server; feeds real protocol messages; records what reaches the glasses. */
  async function live() {
    vi.resetModules();
    vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null, addEventListener: () => {} });
    vi.stubGlobal("window", { addEventListener: () => {} });
    let onMessage: ((m: unknown) => void) | null = null;
    vi.doMock("../src/core/net", () => ({
      connectServer: (receive: (m: unknown) => void) => {
        onMessage = receive;
        return { send: () => {}, sendBinary: () => {}, isOpen: () => true, close: () => {} };
      },
    }));
    const texts = new Map<string, string>();
    const tiles = new Map<string, Uint8Array>();
    const bridge = {
      createStartUpPageContainer: async (spec: { textObject: { containerName: string; content: string }[] }) => {
        for (const t of spec.textObject) texts.set(t.containerName, t.content);
        return StartUpPageCreateResult.success;
      },
      textContainerUpgrade: async (u: { containerName: string; content: string }) => (texts.set(u.containerName, u.content), true),
      updateImageRawData: async (u: { containerName: string; imageData: Uint8Array | number[] }) => (tiles.set(u.containerName, Uint8Array.from(u.imageData)), ImageRawDataUpdateResult.success),
      audioControl: async () => true,
      onEvenHubEvent: () => () => {},
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/hackos/main");
    await vi.waitFor(() => expect(onMessage).not.toBeNull());
    return { texts, tiles, feed: (data: HackView) => onMessage!({ type: "hack", data }) };
  }

  it("makes the texts, the speed bars and the tiles from a real finished answer with samples", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 25, 18, 16, 0));
    try {
      const { texts, tiles, feed } = await live();
      const view: HackView = { ...base, state: "done", model: "qwen3.8-27b", prompt: "Give me three names", answer: "• Windward Club\n• Harbour Reach", stats: "2.1 s  ·  96 tokens", rate: [10, 20, 40] };
      feed(view);
      await vi.waitFor(() => expect(texts.get("body")).toBe("• Windward Club\n• Harbour Reach"));
      expect([texts.get("status"), texts.get("prompt")]).toEqual(["HackOS", "“Give me three names”"]);
      // The tiles are the renderer's frame for the same screen: still core (time 2), clock 18:16, bars from `rate`.
      const rendered = renderHack(hackScreen(view, 0, new Date()), { t: 2, clock: "18:16" });
      const expected = calibrate(rendered);
      await vi.waitFor(() => expect(tiles.size).toBe(4));
      const names = ["t00", "t10", "t01", "t11"];
      const at = [[0, 0], [288, 0], [0, 144], [288, 144]] as const;
      await vi.waitFor(() => {
        names.forEach((name, i) => {
          const [x0, y0] = at[i] ?? [0, 0];
          const want = new Uint8Array(288 * 144);
          for (let y = 0; y < 144; y++) want.set(expected.subarray((y0 + y) * 576 + x0, (y0 + y) * 576 + x0 + 288), y * 288);
          const got = tiles.get(name) ?? new Uint8Array();
          let n = 0;
          for (let k = 0; k < want.length; k++) if (got[k] !== want[k]) n++;
          expect(n, name).toBe(0);
        });
      }, { timeout: 3000, interval: 100 });
      // The header carries the bars and "23 TOK/S" (text in the raster), so the frame holds lit pixels where the bars stand.
      expect(rendered.slice(10 * 576 + 378, 10 * 576 + 444).some((v) => v > 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HackOS text never shares pixels with the raster", () => {
  /** Every line of glasses text, as a box (its measured width, 27 px high), with the number of lit raster pixels under it. */
  function overlaps(s: HackScreen, t: number, reveal = 1): string[] {
    const pixels = renderHack(s, { t, clock: "18:16", reveal, level: 0.5 });
    const found: string[] = [];
    for (const line of screenTexts(s)) {
      const width = Math.min(576 - line.x, Math.ceil(textWidth(line.text)));
      let lit = 0;
      for (let y = line.y; y < Math.min(288, line.y + 27); y++) for (let x = line.x; x < line.x + width; x++) if (pixels[y * 576 + x]) lit++;
      if (lit) found.push(`"${line.text}" at (${line.x}, ${line.y}): ${lit} lit pixels`);
    }
    return found;
  }
  const views: [string, HackView | null, string?][] = [
    ["connecting", null],
    ["note, no view", null, "No pairing key in the page URL."],
    ...DEMO_SCENES.map((scene): [string, HackView | null] => [`demo ${scene}`, demoView(scene, now.getTime(), 7)]),
    ["idle with a note", { ...base, error: "Didn't catch that. Hold and speak again." }],
    ["done with a note", { ...base, state: "done", prompt: "q", answer: "A.", error: "A note." }],
    ["done, no samples", { ...base, state: "done", prompt: "q", answer: "A.", stats: "1.5 s" }],
  ];
  for (const [name, view, notice] of views) {
    it(`${name}: no text line has lit raster pixels under it`, () => {
      for (const t of [0.4, 3.3, 7.9, 21.7]) {
        const s = hackScreen(view, 0, now, notice);
        // The waking prompt sits where the board's own core ring passes (the board has the same overlap), so it is judged on the board's terms.
        const found = overlaps(s, t).filter((line) => !(s.layout === "waking" && line.startsWith("\"“")));
        if (s.layout === "waking") expect(overlaps(s, t).length).toBeLessThanOrEqual(1);
        expect(found, `${name} at t = ${t}`).toEqual([]);
      }
    });
  }
  it("shows the hint without the footer, and the footer without the hint", () => {
    const idle = hackScreen(base, 0, now);
    expect([idle.hint.content !== "", idle.footer !== ""]).toEqual([true, false]);
    const done = hackScreen({ ...base, state: "done", prompt: "q", answer: "A." }, 0, now);
    expect([done.hint.content !== "", done.footer !== ""]).toEqual([false, true]);
  });
  it("keeps the opening's hint clear of the raster too", () => {
    const s = bootScreen(hackScreen({ ...base, state: "done", prompt: "q", answer: "A." }, 0, now));
    for (const r of [0, 0.2, 0.6, 0.93]) expect(overlaps(s, 3, r)).toEqual([]);
  });
});
