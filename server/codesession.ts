import { homedir } from "node:os";
import type { RawData, WebSocket } from "ws";
import { ClientMessageSchema, speakerFromCode, type CodeHub, type ServerMessage } from "../src/core/protocol";
import { Coder } from "./coder";
import { log } from "./log";
import { Segmenter, type Segment } from "./segmenter";
import { transcribe } from "./whisper";

export const MAX_TABS = 6;
/** A hold that lasts this long is thrown away: its release was lost. Above the page's own limit (MAX_HOLD_MS). */
export const MAX_RECORDING_MS = 90_000;
export const DISCARD_NOTE = "Recording stopped. Nothing was sent. Hold and speak again.";
export const CAP_NOTE = `Recording stopped after ${MAX_RECORDING_MS / 1000} seconds. Nothing was sent. Hold and speak again.`;

/**
 * The Code tabs, shared by every connection, so a reconnect (phone locked) keeps
 * the sessions and running tasks. Tabs start from CODE_DIRS (comma-separated)
 * or CODE_DIR.
 */
export class Hub {
  private tabs: { id: number; coder: Coder }[] = [];
  private nextId = 1;
  private listeners = new Set<(hub: CodeHub) => void>();
  private error = "";
  /**
   * The instruction each tab is transcribing, shared by every connection: a stop or a new session
   * from any connection (a reconnected phone, a second client) cancels it.
   */
  readonly speech = new Map<number, { cancelled: boolean }>();

  constructor() {
    const dirs = (process.env.CODE_DIRS ?? process.env.CODE_DIR ?? "")
      .split(",")
      .map((d) => d.trim().replace(/^~(?=\/|$)/, homedir()))
      .filter(Boolean);
    // Startup problems stay on show (not cleared by the next folder that opens).
    const errors = dirs.slice(0, MAX_TABS).map((dir) => this.add(dir)).filter(Boolean);
    if (dirs.length === 0) errors.push("Set CODE_DIRS in .env to one or more project folders, then restart.");
    if (dirs.length > MAX_TABS) {
      const ignored = dirs.slice(MAX_TABS);
      log.warn(`CODE_DIRS has more than ${MAX_TABS} folders; extra folders ignored`, { ignored });
      errors.push(`${ignored.length} more CODE_DIRS folder(s) ignored: at most ${MAX_TABS} tabs.`);
    }
    this.error = errors.join("\n");
  }

  snapshot(): CodeHub {
    return { tabs: this.tabs.map((t) => ({ id: t.id, view: t.coder.view })), error: this.error };
  }

  subscribe(listener: (hub: CodeHub) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private changed = (): void => {
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  };

  get(id: number): Coder | null {
    return this.tabs.find((t) => t.id === id)?.coder ?? null;
  }

  /** Opens a tab; returns why not, or "". */
  private add(dir: string): string {
    try {
      this.tabs.push({ id: this.nextId++, coder: new Coder(dir, this.changed) });
      return "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("code tab not opened", { dir, error: message });
      return message;
    }
  }

  open(dir: string): void {
    if (this.tabs.length >= MAX_TABS) return;
    this.error = this.add(dir);
    this.changed();
  }

  close(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || this.tabs.length <= 1) return; // keep at least one tab
    tab.coder.stop();
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.changed();
  }
}

let hub: Hub | null = null;
const sharedHub = () => (hub ??= new Hub());

/**
 * One Code app connection. Audio arrives only while push-to-talk is held; on
 * release the speech is transcribed locally and sent to that tab's session.
 */
export class CodeSession {
  private segments: Promise<string>[] = [];
  private segmenter = new Segmenter((segment) => this.segments.push(this.text(segment)), { silenceMs: 1500, maxSpeechMs: 60_000 });
  private recordingTab: number | null = null;
  /** Ends a recording whose release does not come (MAX_RECORDING_MS). */
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: () => void;

  constructor(private ws: WebSocket) {
    this.unsubscribe = sharedHub().subscribe((data) => this.send({ type: "code", data }));
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => {
      this.unsubscribe();
      // The release can no longer arrive: drop the hold, so the tab leaves "recording".
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
      log.warn("code transcription failed", { error: String(error) });
      return "";
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (this.recordingTab !== null && buffer.length >= 3) this.segmenter.push(buffer.subarray(1), speakerFromCode(buffer[0]));
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
    const h = sharedHub();
    switch (msg.type) {
      case "code_ptt": {
        if (!msg.on) {
          // A forced stop (an exit, the page's time limit) drops what was heard; a release runs it.
          if (msg.discard) this.discardSpeech(DISCARD_NOTE);
          else void this.finishSpeech();
          break;
        }
        const coder = h.get(msg.tab);
        if (!coder) return;
        // A press while a recording is open: its release was lost. Start over, without what it heard.
        this.discardSpeech("");
        // The tab's last instruction is still being transcribed: refused (the page refuses it too), so neither is lost.
        if (h.speech.has(msg.tab)) return;
        this.recordingTab = msg.tab;
        coder.setInput("recording");
        this.capTimer = setTimeout(() => this.discardSpeech(CAP_NOTE), MAX_RECORDING_MS);
        break;
      }
      case "code_prompt":
        void h.get(msg.tab)?.run(msg.text);
        break;
      case "code_decide":
        h.get(msg.tab)?.decideFromGlasses(msg.id, msg.allow);
        break;
      case "code_stop":
        this.cancelSpeech(msg.tab);
        h.get(msg.tab)?.stop();
        break;
      case "code_new":
        this.cancelSpeech(msg.tab);
        h.get(msg.tab)?.reset();
        break;
      case "code_tab_open": {
        const from = h.get(msg.tab);
        if (from) h.open(from.root);
        break;
      }
      case "code_tab_close":
        h.close(msg.tab);
        break;
      default:
        break;
    }
  }

  private cancelSpeech(tab: number): void {
    const h = sharedHub();
    const speech = h.speech.get(tab);
    if (!speech) return;
    speech.cancelled = true;
    h.speech.delete(tab);
    h.get(tab)?.setInput("idle", "Cancelled.");
  }

  /** Ends this connection's recording and throws its audio away; `note` shows on the tab that recorded. */
  private discardSpeech(note: string): void {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.segmenter.reset();
    this.segments = [];
    const tab = this.recordingTab;
    this.recordingTab = null;
    if (tab !== null) sharedHub().get(tab)?.setInput("idle", note);
  }

  private async finishSpeech(): Promise<void> {
    const tab = this.recordingTab;
    if (tab === null) return;
    this.recordingTab = null;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    const coder = sharedHub().get(tab);
    if (!coder) return;
    coder.setInput("transcribing");
    this.segmenter.flush();
    // Take this instruction's segments now, so a recording that starts meanwhile keeps its own.
    const segments = this.segments;
    this.segments = [];
    const speech = { cancelled: false };
    const h = sharedHub();
    h.speech.set(tab, speech);
    const prompt = (await Promise.all(segments)).filter(Boolean).join(" ").trim();
    if (h.speech.get(tab) === speech) h.speech.delete(tab);
    // Stopped, or a new session asked for, while it was transcribed: drop it.
    if (speech.cancelled) return;
    // The tab was closed meanwhile: its coder is gone from the glasses, so nothing could show or stop the run.
    if (sharedHub().get(tab) !== coder) return;
    if (!prompt) {
      coder.setInput("idle", "Didn't catch that. Hold and speak again.");
      return;
    }
    await coder.run(prompt);
  }
}
