import { execFileSync } from "node:child_process";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { ClientMessageSchema, speakerFromCode, type HackView, type ServerMessage } from "../src/core/protocol";
import { log } from "./log";
import { Segmenter, type Segment } from "./segmenter";
import { WhisperUnavailableError, transcribe } from "./whisper";

/**
 * HackOS: talk to your own model. The model runs on an OpenAI-compatible server
 * (Ollama on a Runpod serverless GPU), which sleeps when idle, so the first
 * message after a pause waits for the GPU to start.
 */

const BASE_URL = (process.env.HACKOS_URL ?? "").replace(/\/+$/, "");
const MODEL = process.env.HACKOS_MODEL ?? "qwen3.8-27b";
/** "none" turns the model's thinking off, which keeps spoken answers fast. */
const REASONING = process.env.HACKOS_REASONING ?? "none";
const KEYCHAIN_ITEM = process.env.HACKOS_KEYCHAIN_ITEM ?? "runpod-api-key";
const USER_NAME = process.env.HUD_USER_NAME ?? "the user";

/** A hold that lasts this long is thrown away: its release was lost. Above the page's own limit (MAX_HOLD_MS). */
export const MAX_RECORDING_MS = 90_000;
export const DISCARD_NOTE = "Recording stopped. Nothing was sent. Hold and speak again.";
export const CAP_NOTE = `Recording stopped after ${MAX_RECORDING_MS / 1000} seconds. Nothing was sent. Hold and speak again.`;
/** Turns kept as context for the next message. */
export const MAX_TURNS = 12;
/** How long one message may wait for a sleeping GPU to start. */
const WAKE_BUDGET_MS = 180_000;
const ATTEMPT_MS = 100_000;
const RETRY_PAUSE_MS = 3_000;
/** No reply after this long means the GPU is starting; say so. */
const WAKING_AFTER_MS = 4_000;
/** Streaming text reaches the screens at most this often. */
const PUSH_MS = 120;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Network errors that a starting GPU can cause: the connection timed out or dropped. */
const WAKE_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export type Turn = { prompt: string; answer: string };
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function systemPrompt(now: Date, userName = USER_NAME): string {
  return `You are HackOS, ${userName}'s personal assistant. You are an open-weight model on a GPU server that ${userName} rents and controls, not on the Mac or the glasses. ${userName} talks to you by voice through smart glasses and types to you in a terminal on a Mac.

Rules:
- Answer in plain text, at most 80 words, unless ${userName} asks for more detail or for code. The glasses show six short lines at a time.
- Lead with the direct answer. No preamble, no headings, no markdown other than "- " for short lists.
- Spoken messages arrive as speech-to-text. Read past small transcription mistakes; if a message makes no sense, ask one short question.
- If you do not know something, say so in one line. Never invent facts.

Current time: ${now.toString()}`;
}

/** The request messages: system prompt, the kept turns, then the new message. */
export function buildMessages(history: Turn[], prompt: string, now: Date, userName = USER_NAME): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(now, userName) },
    ...history.slice(-MAX_TURNS).flatMap((t): ChatMessage[] => [
      { role: "user", content: t.prompt },
      { role: "assistant", content: t.answer },
    ]),
    { role: "user", content: prompt },
  ];
}

const ChunkSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() })),
});

/** Reads the complete lines of an OpenAI-style event stream; `rest` is the unfinished tail. */
export function parseSse(buffer: string): { deltas: string[]; done: boolean; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      continue; // a keep-alive or a line this client does not know
    }
    const parsed = ChunkSchema.safeParse(json);
    const text = parsed.success ? parsed.data.choices[0]?.delta?.content : null;
    if (text) deltas.push(text);
  }
  return { deltas, done, rest };
}

export function answerStats(answer: string, ms: number): string {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  return `${words} ${words === 1 ? "word" : "words"}  ·  ${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * True for a failed attempt that a sleeping GPU explains: the attempt timed out, or the
 * connection dropped. A refused connection, an unknown host, a bad URL or a TLS error
 * does not get better with time, so it is reported at once.
 */
export function mayBeWaking(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true; // the attempt ran out of ATTEMPT_MS
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && WAKE_CODES.has(code);
}

/** An error with a message that is ready to show on the glasses. */
class HackError extends Error {}

let cachedKey: string | null = null;
function apiKey(): string {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.HACKOS_API_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  try {
    const key = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_ITEM, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (key) return (cachedKey = key);
  } catch {
    // falls through to the message below
  }
  throw new HackError(`No API key. Save it in the Keychain as "${KEYCHAIN_ITEM}" or set HACKOS_API_KEY in .env.`);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

const blankView = (): HackView => ({
  state: BASE_URL ? "idle" : "off",
  model: MODEL,
  prompt: "",
  answer: "",
  stats: "",
  error: BASE_URL ? "" : "Set HACKOS_URL in .env to your model server, then restart.",
  startedAt: null,
  history: [],
});

/** The one conversation, shared by every connection, so a reconnect keeps it. */
export class HackBrain {
  view: HackView = blankView();
  private listeners = new Set<(view: HackView) => void>();
  private abort: AbortController | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: (view: HackView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.view.state === "thinking" || this.view.state === "waking" || this.view.state === "answering";
  }

  private push = (): void => {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.listeners.forEach((l) => l(this.view));
  };

  private set(patch: Partial<HackView>, now = true): void {
    this.view = { ...this.view, ...patch };
    if (now) this.push();
    else this.pushTimer ??= setTimeout(this.push, PUSH_MS);
  }

  /** Push-to-talk feedback: recording, transcribing, or back to rest with a note. */
  setInput(state: "recording" | "transcribing" | "idle", note = ""): void {
    if (this.view.state === "off" || this.busy) return;
    this.set(state === "idle" ? { state: this.view.answer ? "done" : "idle", error: note } : { state, error: "" });
  }

  stop(): void {
    if (!this.busy) return;
    this.abort?.abort();
    this.abort = null;
    this.set({ state: this.view.answer ? "done" : "idle", stats: this.view.answer ? "stopped" : "", startedAt: null });
  }

  reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.view = blankView();
    this.push();
  }

  async run(prompt: string): Promise<void> {
    if (this.view.state === "off") return;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const started = Date.now();
    const context = this.view.history;
    this.set({ state: "thinking", prompt, answer: "", stats: "", error: "", startedAt: started });
    const wakeTimer = setTimeout(() => {
      if (this.abort === controller && this.view.state === "thinking") this.set({ state: "waking" });
    }, WAKING_AFTER_MS);
    try {
      const response = await this.open(buildMessages(context, prompt, new Date()), controller.signal, started);
      clearTimeout(wakeTimer);
      const answer = await this.read(response, controller.signal);
      if (controller.signal.aborted) return;
      if (!answer.trim()) throw new HackError("The model returned no text. Ask again.");
      this.set({
        state: "done",
        answer,
        stats: answerStats(answer, Date.now() - started),
        startedAt: null,
        history: [...context, { prompt, answer }].slice(-MAX_TURNS),
      });
    } catch (error) {
      if (controller.signal.aborted) return; // stopped, or replaced by a newer message
      const message = error instanceof HackError ? error.message : "The model server could not be reached. Check the network and HACKOS_URL.";
      log.warn("hackos request failed", { error: String(error), cause: String((error as Error | undefined)?.cause ?? "") });
      this.set({ state: "error", error: message, startedAt: null });
    } finally {
      clearTimeout(wakeTimer);
      if (this.abort === controller) this.abort = null;
    }
  }

  /** Sends the request, and keeps trying while a sleeping GPU starts. */
  private async open(messages: ChatMessage[], signal: AbortSignal, started: number): Promise<Response> {
    const key = apiKey();
    const body = JSON.stringify({ model: MODEL, messages, stream: true, ...(REASONING ? { reasoning_effort: REASONING } : {}) });
    for (;;) {
      let status = 0;
      // The limit covers the wait for a reply (and an error body) only. A timeout signal on
      // fetch stays armed on the body, and would cut an answer that is still streaming.
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(new DOMException("No reply from the model server in time.", "TimeoutError")), ATTEMPT_MS);
      try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.any([signal, attempt.signal]),
        });
        if (response.ok && response.body) return response;
        status = response.status;
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        log.warn("hackos server answered", { status, detail });
        if (status === 401 || status === 403) {
          cachedKey = null; // read the key again on the next message, so a corrected key works without a restart
          throw new HackError("The model server rejected the API key. Check the key in the Keychain.");
        }
        if (status === 404) throw new HackError(`The model server does not know "${MODEL}". Check HACKOS_MODEL and HACKOS_URL.`);
        if (!RETRY_STATUS.has(status)) throw new HackError(`The model server answered HTTP ${status}.`);
      } catch (error) {
        if (signal.aborted || error instanceof HackError || !mayBeWaking(error)) throw error;
        log.debug("hackos attempt failed; the GPU may be starting", { error: String(error) });
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() - started > WAKE_BUDGET_MS) {
        throw new HackError(`The GPU did not start in ${Math.round(WAKE_BUDGET_MS / 60_000)} minutes${status ? ` (HTTP ${status})` : ""}. Try again.`);
      }
      if (this.view.state === "thinking") this.set({ state: "waking" });
      await sleep(RETRY_PAUSE_MS, signal);
      if (signal.aborted) throw new Error("stopped");
    }
  }

  private async read(response: Response, signal: AbortSignal): Promise<string> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let stalled = false;
    for (;;) {
      // No bytes for ATTEMPT_MS: the stream has stalled. cancel() ends the pending read with done.
      const idle = setTimeout(() => {
        stalled = true;
        void reader.cancel().catch(() => {});
      }, ATTEMPT_MS);
      const { value, done } = await reader.read().finally(() => clearTimeout(idle));
      if (stalled) throw new HackError("The model stopped answering part way. Ask again.");
      if (signal.aborted) break;
      // At the end, flush the decoder and close the last line, so a final line without a newline still counts.
      const parsed = parseSse(buffer + (done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true })));
      buffer = parsed.rest;
      if (parsed.deltas.length > 0) {
        answer += parsed.deltas.join("");
        this.set({ state: "answering", answer }, this.view.state !== "answering");
      }
      if (done || parsed.done) break;
    }
    return answer;
  }
}

let brain: HackBrain | null = null;
const sharedBrain = () => (brain ??= new HackBrain());
/** The connection whose hold put the shared view in "recording". */
let recorder: HackSession | null = null;
/** Speech that is being transcribed; hack_stop cancels it. */
let pendingSpeech: { cancelled: boolean } | null = null;

/**
 * One HackOS connection (the glasses page or the Mac terminal). Audio arrives
 * only while push-to-talk is held; on release the speech is transcribed locally
 * and sent to the model.
 */
export class HackSession {
  private segments: Promise<string>[] = [];
  private segmenter = new Segmenter((segment) => this.segments.push(this.text(segment)), { silenceMs: 1500, maxSpeechMs: 60_000 });
  private recording = false;
  /** Ends a recording whose release does not come (MAX_RECORDING_MS). */
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private whisperDown = false;
  private readonly unsubscribe: () => void;

  constructor(private ws: WebSocket) {
    this.unsubscribe = sharedBrain().subscribe((data) => this.send({ type: "hack", data }));
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => {
      this.unsubscribe();
      // The release can no longer arrive. End this hold, or the shared view stays at "recording".
      this.discardSpeech(DISCARD_NOTE);
    });
  }

  private send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  private async text(segment: Segment): Promise<string> {
    try {
      return await transcribe(segment.pcm);
    } catch (error) {
      log.warn("hackos transcription failed", { error: String(error) });
      if (error instanceof WhisperUnavailableError) this.whisperDown = true;
      return "";
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (this.recording && buffer.length >= 3) this.segmenter.push(buffer.subarray(1), speakerFromCode(buffer[0]));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    const b = sharedBrain();
    switch (msg.type) {
      case "hack_ptt":
        if (msg.on) {
          // A press while a recording is open: its release was lost. Start over, without what it heard.
          this.discardSpeech("");
          // Also while the last hold is still being transcribed: refused (the page refuses it too), so neither message is lost.
          if (b.busy || b.view.state === "off" || pendingSpeech) return;
          this.recording = true;
          recorder = this;
          this.whisperDown = false;
          b.setInput("recording");
          this.capTimer = setTimeout(() => this.discardSpeech(CAP_NOTE), MAX_RECORDING_MS);
        } else if (msg.discard) this.discardSpeech(DISCARD_NOTE); // a forced stop (an exit, the page's time limit)
        else void this.finishSpeech();
        break;
      case "hack_prompt":
        void b.run(msg.text);
        break;
      case "hack_stop":
        if (pendingSpeech) {
          // A double tap while the speech is transcribed: drop it, so it is not sent to the model.
          pendingSpeech.cancelled = true;
          pendingSpeech = null;
          b.setInput("idle", "Cancelled.");
        }
        b.stop();
        break;
      case "hack_new":
        b.reset();
        break;
      default:
        break;
    }
  }

  /** Ends this connection's recording and throws its audio away; `note` shows when it was the shared recording. */
  private discardSpeech(note: string): void {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.segmenter.reset();
    this.segments = [];
    if (!this.recording) return;
    this.recording = false;
    if (recorder === this) {
      recorder = null;
      sharedBrain().setInput("idle", note);
    }
  }

  private async finishSpeech(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    if (recorder === this) recorder = null;
    const b = sharedBrain();
    b.setInput("transcribing");
    this.segmenter.flush();
    // Take the segments now: a new hold during the transcription starts a new list.
    const segments = this.segments;
    this.segments = [];
    const speech = { cancelled: false };
    pendingSpeech = speech;
    const prompt = (await Promise.all(segments)).filter(Boolean).join(" ").trim();
    if (pendingSpeech === speech) pendingSpeech = null;
    if (speech.cancelled) return;
    if (!prompt) {
      b.setInput("idle", this.whisperDown ? "Speech-to-text is not running. Start everything with npm run dev." : "Didn't catch that. Hold and speak again.");
      return;
    }
    await b.run(prompt);
  }
}
