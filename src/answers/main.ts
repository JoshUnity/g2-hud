import {
  AudioInputSource,
  AudioSpeakerRole,
  OsEventTypeList,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import type { Box } from "../core/box";
import { eventTypeOf } from "../core/events";
import { ImagePipe } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure } from "../core/page";
import { speakerCode, type ServerMessage, type Speaker } from "../core/protocol";
import { Sigil, voiceLevel } from "./animator";
import {
  CARD,
  CLOCK,
  CUE_MS,
  CUE_SEEN_MS,
  QUESTION,
  SIGIL,
  STATUS,
  acceptCue,
  confirmCue,
  fitBytes,
  initialState,
  screen,
  stepCue,
  type Cell,
  type HudState,
} from "./hud";
import { TEXT_BOXES, createPage } from "./pages";

/** Answers: the real-time answer teleprompter, with meetings saved to Obsidian. */

const RENDER_INTERVAL_MS = 150;
/** A text upgrade with no answer by then counts as failed (the SDK has no timeout of its own). */
const UPGRADE_TIMEOUT_MS = 3000;
/** After a failed upgrade, the screen is sent again this much later. */
const RETRY_MS = 1000;
/** No audio frame for this long while listening: re-arm the microphone once, then report it. */
const AUDIO_STALL_MS = 10_000;
const MIC_OFF = "MIC NOT AVAILABLE  ·  tap to retry or reopen";
/** The server's first status on every connect. */
const GREETING = "Listening…";

const state: HudState = initialState();
let listening = true;
let bridge: EvenAppBridge | null = null;
const sigil = new Sigil(SIGIL);
let currentAnswerId = -1;
/** The host closed the app (exit event); nothing more is sent to the glasses or the server. */
let stopped = false;
let lastAudioAt = 0;
/** The watchdog already re-armed the microphone once since the last frame. */
let rearmed = false;
const demo = new URLSearchParams(location.search).get("demo");

// ---- Phone-side page (debug view and typed questions) -------------------------

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function showStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function appendLog(className: string, text: string): HTMLElement | null {
  if (!logEl) return null;
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
  return line;
}

// ---- Glasses display ---------------------------------------------------------

let renderTimer: ReturnType<typeof setTimeout> | null = null;
/** What the glasses show: set only after the host accepted the upgrade. */
const shown = new Map<string, Cell>();
let rendering = false;
let dirty = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRender(): void {
  if (stopped || renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void render();
  }, RENDER_INTERVAL_MS);
}

function cells(): Record<string, Cell> {
  const now = new Date();
  // The recall cue moves on before the screen is built: drawn, acknowledged after 3 s on the lens, or dropped.
  const step = stepCue(state, now.getTime());
  state.cue = step.cue;
  if (step.seen && step.cue) server.send({ type: "recall_shown", name: step.cue.name });
  const s = screen(state, now);
  state.page = s.page;
  sigil.setMode(s.sigil);
  return { [STATUS.name]: s.status, [CLOCK.name]: s.clock, [QUESTION.name]: s.question, [CARD.name]: s.card };
}

/** The host accepted this QUESTION text: a drawn cue in it is now on the lens, and its 3 s and 10 s start. */
function questionShown(content: string): void {
  const cue = confirmCue(state.cue, content, Date.now());
  if (cue === state.cue) return;
  state.cue = cue;
  setTimeout(scheduleRender, CUE_SEEN_MS + 50);
  setTimeout(scheduleRender, CUE_MS + 50);
}

/** True when the host accepted the upgrade. A rejection, or no answer in time, counts as a failure. */
function upgrade(box: Box, cell: Cell): Promise<boolean> {
  if (!bridge) return Promise.resolve(false);
  const sent = bridge
    .textContainerUpgrade(new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: cell.content, textColor: cell.color }))
    .then((ok) => Boolean(ok))
    .catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), UPGRADE_TIMEOUT_MS);
  });
  return Promise.race([sent, late]).finally(() => clearTimeout(timer));
}

async function update(box: Box, cell: Cell): Promise<boolean> {
  const next = { content: fitBytes(cell.content), color: cell.color };
  // No page yet: nothing reached the lens.
  if (!bridge) return false;
  const prev = shown.get(box.name);
  if (prev && prev.content === next.content && prev.color === next.color) return true;
  const ok = await upgrade(box, next);
  if (ok) shown.set(box.name, next);
  return ok;
}

/** One render at a time. A render asked for while one runs waits, then sends the newest state. */
async function render(): Promise<void> {
  // Before the page exists, start() sends the first screen itself.
  if (stopped || !bridge) return;
  if (rendering) {
    dirty = true;
    return;
  }
  rendering = true;
  let ok = true;
  try {
    // cells() is read for each box, so a slow upgrade does not make the next box send old text.
    for (const box of TEXT_BOXES) {
      const cell = cells()[box.name] ?? { content: "", color: 1 };
      const done = await update(box, cell);
      if (done && box.name === QUESTION.name) questionShown(cell.content);
      ok = done && ok;
    }
  } finally {
    rendering = false;
  }
  if (dirty) {
    dirty = false;
    scheduleRender();
  } else if (!ok && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      scheduleRender();
    }, RETRY_MS);
  }
}

function setMode(mode: HudState["mode"]): void {
  state.mode = listening || mode === "error" ? mode : "paused";
  scheduleRender();
}

function toast(text: string, ms = 5000): void {
  state.toast = { text, until: Date.now() + ms };
  scheduleRender();
  setTimeout(scheduleRender, ms + 50);
}

// ---- Server ------------------------------------------------------------------

let answerLine: HTMLElement | null = null;
let lastHeard = "";

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "status":
      showStatus(message.text);
      if (message.text.startsWith("Saved")) toast(`SAVED  ·  ${message.text.replace(/^Saved:\s*/, "")}`, 4000);
      else if (state.mode === "connecting" || state.mode === "error") setMode("listening");
      // The connect greeting while paused: the lens keeps PAUSED, because the microphone is off.
      else if (state.mode !== "paused" || message.text !== GREETING) toast(message.text);
      break;
    case "utterance":
      if (message.speaker !== "self") lastHeard = message.text;
      appendLog(message.speaker === "self" ? "me" : "them", `${message.speaker === "self" ? "Me" : "Them"}: ${message.text}`);
      break;
    case "thinking":
      if (state.mode !== "answer" || state.answeredAt !== null) {
        // A finished answer and its question stay on the card until a new answer starts.
        if (!state.answer) state.question = lastHeard;
        setMode("thinking");
      }
      break;
    case "answer_none":
      if (state.mode === "thinking") {
        if (!state.answer) state.question = "";
        setMode(state.answer ? "answer" : "listening");
      }
      break;
    case "answer_start":
      currentAnswerId = message.id;
      state.question = message.question;
      state.answer = "";
      state.follow = true;
      state.answeredAt = null;
      setMode("answer");
      answerLine = appendLog("answer", "> ");
      break;
    case "answer_delta":
      if (message.id !== currentAnswerId) return;
      state.answer += message.text;
      if (answerLine) answerLine.textContent = `> ${state.answer}`;
      scheduleRender();
      break;
    case "answer_done":
      if (message.id === currentAnswerId) {
        state.answeredAt = Date.now();
        scheduleRender();
      }
      break;
    case "recall":
      state.cue = acceptCue(state.cue, message, Date.now());
      // The name only: the facts never go on the phone page.
      appendLog("recall", "Recall: " + message.name);
      scheduleRender();
      break;
    case "error":
      showStatus(`Error: ${message.message}`);
      state.error = message.message;
      setMode("error");
      break;
    default:
      break;
  }
}

// Demo scenes show sample data without the server: no socket, no form.
const server: Server = demo
  ? { send: () => {}, sendBinary: () => {}, isOpen: () => false, close: () => {} }
  : connectServer(handleServerMessage, (connected) => {
      showStatus(connected ? "Connected" : "Disconnected - retrying");
      if (!connected) setMode("connecting");
    });
if (demo) {
  document.getElementById("ask")?.remove();
  showStatus(`Demo scene: ${demo}`);
}

document.getElementById("ask")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("question") as HTMLInputElement | null;
  const text = input?.value.trim();
  if (!text || !input) return;
  server.send({ type: "ask", text });
  input.value = "";
});
document.getElementById("end")?.addEventListener("click", () => server.send({ type: "end_meeting" }));

// ---- Audio and input from the glasses ----------------------------------------

function roleToSpeaker(role: AudioSpeakerRole): Speaker {
  if (role === AudioSpeakerRole.Self) return "self";
  if (role === AudioSpeakerRole.Other) return "other";
  return "unknown";
}

function forwardAudio(pcm: Uint8Array, role: AudioSpeakerRole): void {
  if (!listening) return;
  sigil.setLevel(voiceLevel(pcm));
  if (!server.isOpen()) return;
  const frame = new Uint8Array(pcm.length + 1);
  frame[0] = speakerCode(roleToSpeaker(role));
  frame.set(pcm, 1);
  server.sendBinary(frame);
}

/** The glasses microphone did not open, or sends nothing: say so and wait for a tap. */
function micFailed(): void {
  listening = false;
  if (state.mode !== "error") state.mode = "paused";
  showStatus("The glasses microphone is not available. Tap to try again, or close and reopen Answers.");
  toast(MIC_OFF, 8000);
}

async function setListening(on: boolean): Promise<void> {
  listening = on;
  if (on) {
    lastAudioAt = Date.now();
    rearmed = false;
  }
  const ok = !bridge || (await bridge.audioControl(on, AudioInputSource.Glasses).catch(() => false));
  if (stopped) return;
  if (on && !ok && listening) {
    micFailed();
    return;
  }
  if (!listening) state.mode = "paused";
  else if (state.mode === "paused") state.mode = state.answer ? "answer" : "listening";
  scheduleRender();
}

/** Runs with the 15 s tick. Capture can stop without a word (Android suspend, a host fault). */
function checkAudio(): void {
  if (!listening || !bridge || Date.now() - lastAudioAt < AUDIO_STALL_MS) return;
  if (!rearmed) {
    rearmed = true;
    lastAudioAt = Date.now();
    void bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    return;
  }
  void bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false);
  micFailed();
}

/** The host is closing the app. The WebView can outlive this event, so release everything here. */
let stopPage: (() => void) | null = null;

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  listening = false;
  stopPage?.();
  if (renderTimer) clearTimeout(renderTimer);
  if (retryTimer) clearTimeout(retryTimer);
  void bridge?.audioControl(false, AudioInputSource.Glasses).catch(() => false);
  // Closing the socket makes the server flush the last utterance and save the meeting.
  server.close();
}

function handleGlassesEvent(event: EvenHubEvent): void {
  if (event.audioEvent) {
    lastAudioAt = Date.now();
    rearmed = false;
    forwardAudio(event.audioEvent.audioPcm, event.audioEvent.speakerRole);
    return;
  }
  const pages = screen(state, new Date()).pageCount;
  switch (eventTypeOf(event)) {
    case OsEventTypeList.CLICK_EVENT:
      void setListening(!listening);
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      // Dismissed: drop the rest of this answer if it is still streaming.
      currentAnswerId = -1;
      state.answer = "";
      state.question = "";
      state.follow = true;
      if (state.mode === "answer" || state.mode === "error") setMode("listening");
      scheduleRender();
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
      state.follow = false;
      state.page = Math.max(0, state.page - 1);
      scheduleRender();
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      state.page = Math.min(pages - 1, state.page + 1);
      state.follow = state.page === pages - 1;
      scheduleRender();
      break;
    case OsEventTypeList.LONG_PRESS_EVENT:
      server.send({ type: "end_meeting" });
      toast("SAVING TO OBSIDIAN…", 15_000);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      // Android can suspend the WebView; capture stops with it. Re-arm on return.
      // The result is not trusted here (capture may still be open); the audio watchdog decides.
      if (listening && bridge) void bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
      break;
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      shutdown();
      break;
    default:
      break;
  }
}

// ---- Start -------------------------------------------------------------------

async function start(): Promise<void> {
  // `bridge` is set only once the page exists, so no text upgrade goes to a page that is not there yet.
  const host = await waitForEvenAppBridge();
  const content = cells();
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is sent again.
  if (await createPage(host, content)) {
    for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
    questionShown(content[QUESTION.name]?.content ?? "");
  } else notePageFailure();
  bridge = host;
  // A state change that came while the page was created (such as the server's greeting) goes on the lens now.
  scheduleRender();
  const unsubscribe = host.onEvenHubEvent(handleGlassesEvent);
  const pipe = new ImagePipe(host);
  pipe.set([sigil.producer()]);
  void pipe.run();
  // Keeps the clock current, dims old answers and watches the audio.
  const tick = setInterval(() => {
    scheduleRender();
    checkAudio();
  }, 15_000);
  stopPage = () => {
    unsubscribe();
    pipe.stop();
    clearInterval(tick);
  };
  await setListening(true);
}

const boot = demo ? import("./demo").then((m) => m.runDemo(demo)) : start();
boot.catch((error: unknown) => {
  showStatus(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
});
