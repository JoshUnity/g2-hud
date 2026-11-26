import { createServer, type IncomingMessage } from "node:http";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { ClientMessageSchema, speakerFromCode, type ServerMessage, type Speaker } from "../src/core/protocol";
import { pastMeetingsInclude, setPastMeetings, setVaultRecall, streamAnswer, type TranscriptLine } from "./answer";
import { handshakeProblem, requireToken } from "./auth";
import { log } from "./log";
import { LoopsFeed } from "./loops";
import { buildOpenFeed, chooseFeed } from "./open/select";
import { CodeSession } from "./codesession";
import { HackSession } from "./hackos";
import { MeetingRecorder, VaultWriteError, meetingsFolder, recentMeetings } from "./meetings";
import { buildGraph, nodeTitle, type VaultGraph } from "./graph";
import { MAX_NOTES, namesBlocked, MAX_SUBJECTS, NO_RECALL, RECALL_CHARS, RecallTracker } from "./recall";
import { Segmenter, dominantSpeaker, type Segment } from "./segmenter";
import { summarize } from "./summarize";
import { Vault, vaultConfig } from "./vault";
import { WhisperUnavailableError, transcribe } from "./whisper";

const PORT = Number(process.env.PORT ?? 8787);
const HISTORY_LINES = 16;
/** A conversation ends after this long without speech; the next words start a new note. */
const IDLE_END_MS = Number(process.env.MEETING_IDLE_MINUTES ?? 10) * 60_000;
/** No audio for this long ends the utterance in progress: the page paused or the link went silent. */
const AUDIO_GAP_MS = 1000;
const VAULT_ERROR =
  "Cannot write to the Obsidian vault. This conversation is not saved. Check OBSIDIAN_VAULT and the folder permissions, then hold to save.";

const folder = meetingsFolder();
// Vault recall: off (null) unless RECALL_FOLDERS, OBSIDIAN_VAULT and HUD_USER_NAME are set; vaultConfig() logs why not.
const vaultSettings = vaultConfig();
const vault = vaultSettings ? new Vault(vaultSettings) : null;
setVaultRecall(vault !== null);
const sessions = new Set<Session>();

/** The graph of the index in use, rebuilt only when the index is. Never throws: a broken vault sends no graph. */
let graphCache: { index: object; graph: VaultGraph; signature: string } | null = null;
function currentGraph(): { graph: VaultGraph; signature: string } | null {
  try {
    const index = vault?.index;
    if (!vault || !index) return null;
    if (graphCache?.index !== index) {
      const graph = buildGraph(index, vault.notes);
      graphCache = { index, graph, signature: JSON.stringify([graph.nodes, graph.links, graph.total]) };
    }
    return graphCache;
  } catch (error) {
    log.warn("vault graph failed; the page gets no graph", { error: String(error) });
    return null;
  }
}

/** Rescans the vault (throttled inside); when the index changed, the Answers pages get the new graph if it differs. */
function rescan(force = false): void {
  void vault?.refresh(force).then((changed) => {
    if (changed) for (const session of sessions) session.sendGraph();
  });
}

/** Titles of the vault notes whose extracts go with a request, in the order of the audit list. At most 6. */
function noteTitles(paths: string[]): string[] {
  if (!vault || paths.length === 0) return [];
  try {
    const index = vault.index;
    if (!index) return [];
    const byPath = new Map(vault.notes.map((note) => [note.path, note]));
    const titles = [...paths].sort().flatMap((path) => {
      const note = byPath.get(path);
      return note ? [nodeTitle(note)] : [];
    });
    // The rule of the graph: a title that names a blocked note is not sent.
    return [...new Set(titles.filter((title) => title !== "" && !namesBlocked(index, title)))].slice(0, 6);
  } catch (error) {
    log.warn("vault note titles failed; the answer goes without them", { error: String(error) });
    return [];
  }
}

async function refreshPastMeetings(): Promise<void> {
  if (folder) setPastMeetings(await recentMeetings(folder));
}

export class Session {
  private segmenter = new Segmenter((segment) => this.enqueue(segment));
  /** Transcriptions run one at a time so lines stay in order. */
  private queue: Promise<void> = Promise.resolve();
  private history: TranscriptLine[] = [];
  /** Claude requests that are still running, by answer id. */
  private liveAnswers = new Map<number, () => void>();
  private answerId = 0;
  /** Names said in this conversation, for the lens cue and the <vault_notes> block. Reads only the last finished index. */
  private recall = vault
    ? new RecallTracker(() => vault.index, { cue: vault.config.cue, skipMeeting: pastMeetingsInclude, topicLines: HISTORY_LINES })
    : null;
  private recorder = folder ? new MeetingRecorder(folder, () => this.send({ type: "error", message: VAULT_ERROR })) : null;
  private idleTimer: ReturnType<typeof setInterval>;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  /** lastActivity of a conversation the vault refused: the idle timer does not retry it (a new line, a long press or a close does). */
  private idleFailedAt = 0;
  /** The socket has closed: lines still in the pipeline are recorded, not answered. */
  private closed = false;
  /** The graph last sent to this connection: its signature, and which recall subject is which node. */
  private sentGraph: { signature: string; ids: Map<string, number> } | null = null;

  /** `app`: the page that opened the socket. Only "answers" gets the vault graph. */
  constructor(
    private ws: WebSocket,
    readonly app: string | null = null,
  ) {
    sessions.add(this);
    this.send({ type: "status", text: "Listening…" });
    this.sendGraph();
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.close());
    this.idleTimer = setInterval(() => {
      const last = this.recorder?.lastActivity ?? 0;
      if (last > 0 && last !== this.idleFailedAt && Date.now() - last > IDLE_END_MS) void this.endMeeting();
    }, 30_000);
  }

  /** Pushes OSINT updates from Loops to this glasses page. */
  push(message: ServerMessage): void {
    this.send(message);
  }

  /** Sends the vault graph to an Answers page when it differs from the one it has. */
  sendGraph(): void {
    if (this.app !== "answers" || this.closed) return;
    const current = currentGraph();
    if (!current || current.signature === this.sentGraph?.signature) return;
    if (!this.sentGraph && current.graph.nodes.length === 0) return;
    this.sentGraph = { signature: current.signature, ids: current.graph.ids };
    this.send({ type: "vault_graph", nodes: current.graph.nodes, links: current.graph.links, total: current.graph.total });
  }

  private send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (buffer.length < 3) return;
      this.segmenter.push(buffer.subarray(1), speakerFromCode(buffer[0]));
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = setTimeout(() => this.segmenter.flush(), AUDIO_GAP_MS);
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
    switch (parsed.data.type) {
      case "reset":
        this.history = [];
        this.recall?.reset();
        break;
      case "recall_shown":
        this.recall?.shown(parsed.data.name);
        break;
      case "end_meeting":
        // Let the utterance in progress and the queued transcriptions land in this note first.
        this.segmenter.flush();
        void this.queue.then(() => this.endMeeting());
        break;
      case "ask":
        this.onUtterance(parsed.data.text, "other", true);
        break;
      case "position":
        // Goes to the open feed only; with Loops (or no feed) this does nothing and nothing is logged.
        feedChoice.position(parsed.data);
        break;
      default:
        break;
    }
  }

  private enqueue(segment: Segment): void {
    const speaker = dominantSpeaker(segment.speakers);
    const at = new Date();
    this.queue = this.queue.then(async () => {
      const started = Date.now();
      try {
        const text = await transcribe(segment.pcm);
        log.debug("transcribed", { ms: Date.now() - started, audioMs: Math.round(segment.durationMs), speaker });
        if (!text) return;
        this.recorder?.add({ at, speaker, text });
        this.onUtterance(text, speaker);
      } catch (error) {
        log.warn("transcription failed", { error: String(error) });
        if (error instanceof WhisperUnavailableError) {
          this.send({ type: "error", message: "Speech-to-text is not running. Start everything with npm run dev." });
        }
      }
    });
  }

  /** `typed`: a question from the phone page, answered however short it is. */
  private onUtterance(text: string, speaker: Speaker, typed = false): void {
    this.history = [...this.history, { speaker, text }].slice(-HISTORY_LINES);
    this.send({ type: "utterance", text, speaker });
    const cue = this.recall?.observe(text, { typed }) ?? null;
    if (cue) {
      const subject = this.recall?.subjectOf(cue.name);
      const node = subject === undefined ? undefined : this.sentGraph?.ids.get(subject);
      this.send({ type: "recall", ...cue, ...(node === undefined ? {} : { id: node }) });
    }
    // Only lines from someone else can be questions for the wearer.
    if (this.closed || speaker === "self" || (!typed && text.split(/\s+/).length < 3)) {
      // No request goes out for this line, so a rescan cannot delay one. Throttled inside to one per minute.
      rescan();
      return;
    }

    const id = ++this.answerId;
    const live = (): boolean => this.liveAnswers.has(id);
    let answer = "";
    this.send({ type: "thinking", id });
    // Built here, from the index in memory: nothing on the answer path waits for the disk.
    const recalled = this.recall?.context(text) ?? NO_RECALL;
    this.recorder?.addRecalled(recalled.paths);
    const notes = noteTitles(recalled.paths);
    const cancel = streamAnswer(this.history, {
      onNone: () => {
        if (!live()) return;
        this.liveAnswers.delete(id);
        // An older line can still be waiting for its answer; stay in "thinking" until all have decided.
        if (this.liveAnswers.size === 0) this.send({ type: "answer_none", id });
        // This request has decided: a rescan now cannot delay it.
        rescan();
      },
      onStart: () => {
        if (!live()) return;
        // Only now is this line known to be a question: it replaces the answers to older lines.
        for (const [older, cancelOlder] of this.liveAnswers) {
          if (older >= id) continue;
          this.liveAnswers.delete(older);
          cancelOlder();
        }
        this.send({ type: "answer_start", id, question: text, ...(notes.length > 0 ? { notes } : {}) });
      },
      onDelta: (delta) => {
        if (!live()) return;
        answer += delta;
        this.send({ type: "answer_delta", id, text: delta });
      },
      onDone: () => {
        if (!live()) return;
        this.liveAnswers.delete(id);
        this.send({ type: "answer_done", id });
        this.recorder?.addAnswer({ at: new Date(), question: text, answer });
        rescan();
      },
      onError: (message) => {
        if (!live()) return;
        this.send({ type: "error", message });
        // A refusal calls onDone right after this, in the same tick; a failed request does not.
        queueMicrotask(() => this.liveAnswers.delete(id));
      },
    }, recalled.text);
    this.liveAnswers.set(id, cancel);
  }

  private async endMeeting(): Promise<void> {
    // First, before any await: names said from now on belong to the next conversation.
    this.recall?.reset();
    if (!this.recorder) {
      this.send({ type: "status", text: "Set OBSIDIAN_VAULT in .env to save meetings." });
      return;
    }
    try {
      const saving = this.recorder.finish(summarize);
      // finish() has taken its lines; what is heard from now on belongs to the next conversation.
      this.history = [];
      const saved = await saving;
      if (!saved) {
        this.send({ type: "status", text: "Nothing to save yet." });
        return;
      }
      this.send({ type: "status", text: `Saved: ${saved.title}` });
      await refreshPastMeetings();
      // Index the new meeting note now, not at the next throttled rescan.
      rescan(true);
    } catch (error) {
      log.error("saving meeting failed", { error: String(error) });
      if (error instanceof VaultWriteError) this.idleFailedAt = this.recorder.lastActivity;
      this.send({
        type: "error",
        message: error instanceof VaultWriteError ? VAULT_ERROR : "Could not save the meeting. The draft note is still in the vault.",
      });
    }
  }

  private close(): void {
    sessions.delete(this);
    this.closed = true;
    clearInterval(this.idleTimer);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.segmenter.flush();
    for (const cancel of this.liveAnswers.values()) cancel();
    this.liveAnswers.clear();
    // Let the last transcription land, then save.
    void this.queue.then(() => this.endMeeting());
  }
}

const TOKEN = requireToken(process.env.HUD_TOKEN);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("g2-hud answer server\n");
});
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Largest valid message is a ~48 kB JSON prompt; audio frames are under 10 kB.
  maxPayload: 256 * 1024,
  verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
    const problem = handshakeProblem(TOKEN, { url: req.url, origin, host: req.headers.host });
    // Never log req.url: it holds the pairing key.
    if (problem) log.warn("refused glasses page", { reason: problem, origin: origin || null });
    return !problem;
  },
});
const pushAll = (message: ServerMessage) => sessions.forEach((s) => s.push(message));
const feedChoice = chooseFeed(process.env, {
  loops: (target) =>
    new LoopsFeed(
      target,
      (data) => pushAll({ type: "osint", data }),
      (data) => pushAll({ type: "osint_map", data }),
    ),
  open: () =>
    buildOpenFeed(
      process.env,
      {
        // Around and Sky are the only pages that use this data.
        active: () => [...sessions].some((s) => s.app === "around" || s.app === "sky"),
        onUpdate: (data) => pushAll({ type: "osint", data }),
        onMap: (data) => pushAll({ type: "osint_map", data }),
      },
      fetch,
      fileURLToPath(new URL("../.cache/open", import.meta.url)),
    ),
});
const loops = feedChoice.feed;
loops?.start();
if (loops) {
  // Close the ssh tunnel when the server stops, so a tsx reload does not leave one behind.
  process.on("exit", () => loops.stop());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => process.exit(128 + constants.signals[signal]));
  }
}

wss.on("connection", (ws, request) => {
  // ws reports an oversized or malformed frame as "error"; with no listener that stops the server.
  ws.on("error", (error) => log.warn("socket error", { error: String(error) }));
  const app = new URL(request.url ?? "/ws", "http://localhost").searchParams.get("app");
  log.info("glasses page connected", { app: app ?? "answers" });
  if (app === "code") {
    new CodeSession(ws);
    return;
  }
  if (app === "hackos") {
    new HackSession(ws);
    return;
  }
  const session = new Session(ws, app);
  const map = loops?.latestMap();
  if (map) session.push({ type: "osint_map", data: map });
  if (loops?.latest) session.push({ type: "osint", data: loops.latest });
});
// The first scan runs in the background; until it ends there is no cue and no <vault_notes> block.
rescan(true);
await refreshPastMeetings();
// Loopback only: phones reach /ws through the Vite proxy on port 5173.
server.listen(PORT, "127.0.0.1", () =>
  log.info(`answer server on http://127.0.0.1:${PORT}`, {
    meetings: folder ?? "off",
    feed: feedChoice.kind === "loops" ? `loops ${process.env.LOOPS_SSH}` : feedChoice.kind === "open" ? `open data (aircraft: ${process.env.AIRCRAFT_SOURCE || "adsb.fi"}, map: OpenStreetMap, incidents: NDW in the Netherlands)` : "off",
    code: (process.env.CODE_DIRS ?? process.env.CODE_DIR) || "off",
    hackos: process.env.HACKOS_URL ?? "off",
    recall: vault ? vault.config.folders.map((f) => f || ".").join(",") : "off",
    recallLimits: `${MAX_SUBJECTS} subjects, ${MAX_NOTES} notes, ${RECALL_CHARS} chars`,
  }),
);
