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
import { lensCanvas, lensTiles } from "../core/board";
import { eventTypeOf, onExit } from "../core/events";
import { fitBytes, clockText } from "../core/text";
import { ImagePipe, type Producer } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import { speakerCode, type ServerMessage, type Speaker } from "../core/protocol";
import { playSplash } from "../core/splash";
import { voiceLevel } from "../core/voice";
import { LIGHT, type Cell } from "../core/hud";
import { Voice, iconMoves, meterOf, type IconMode } from "./header";
import { ICON, ORDER } from "./icon";
import { drawLens, lensFps } from "./lens";
import { CARD_LINES, QUESTION, TEXT_BOXES, pageSpec } from "./pages";
import { ribbonColumns } from "./ribbon";
import { buildVault } from "./vault";
import { ENTRANCE_MS } from "./lens";
import { CUE_MS, CUE_SEEN_MS, OPEN_MS, acceptCue, confirmCue, initialState, openRatio, screen, stepCue, type Env, type HudState, type Screen } from "./view";
import { SARAH, boardEnv, boardVault, fakeLevel, scene } from "./demo";

/** Answers: the real-time answer teleprompter, with meetings saved to Obsidian. */

const RENDER_INTERVAL_MS = 150;
/** A text upgrade with no answer by then counts as failed (the SDK has no timeout of its own). */
const UPGRADE_TIMEOUT_MS = 3000;
/** After a failed upgrade, the screen is sent again this much later. */
const RETRY_MS = 1000;
/** No audio frame for this long while listening: re-arm the microphone once, then report it. */
const AUDIO_STALL_MS = 10_000;
const MIC_OFF = "Mic not available  ·  tap to retry or reopen";
/** The server's first status on every connect. */
const GREETING = "Listening…";

const state: HudState = initialState();
let listening = true;
let bridge: EvenAppBridge | null = null;
const voice = new Voice();
/** The newest text screen (see cells()). */
let current: Screen = screen(state, new Date());
let iconMode: IconMode = "connecting";
let iconAt = performance.now();
let pipe: ImagePipe | null = null;
/** The demo scene's voice is the made-up one; every other demo scene shows the board's own motion. */
let demoVoice = false;
let currentAnswerId = -1;
/** The host closed the app (exit event); nothing more is sent to the glasses or the server. */
let stopped = false;
let lastAudioAt = 0;
/** The watchdog already re-armed the microphone once since the last frame. */
let rearmed = false;
const demo = new URLSearchParams(location.search).get("demo");
/** `load=<0..1>` holds the opening at that progress (for screenshots); `load=off` skips it. */
const loadParam = new URLSearchParams(location.search).get("load");
const loadOff = loadParam === "off";
const loadFrozen = loadParam !== null && !loadOff && Number.isFinite(Number(loadParam)) ? Number(loadParam) : null;
/** When the opening began (the live page showing); null before that, and after the state left plain listening. */
let openAt: number | null = null;
/** When the recall view last appeared; its entrance runs from then. */
let recallAt = 0;

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
  current = s;
  // Any state change ends the opening for good; it never holds back a cue or an answer.
  if (openAt !== null && (state.mode !== "listening" && state.mode !== "connecting" || state.answer !== "" || state.cue !== null)) openAt = null;
  if (s.icon !== iconMode) {
    iconMode = s.icon;
    iconAt = performance.now();
  }
  return {
    status: s.status,
    question: s.question,
    body: s.body,
    hint: s.hint,
    card1: s.card[0],
    card2: s.card[1],
    card3: s.card[2],
    card4: s.card[3],
  };
}

/** The host accepted this question or card text: a drawn cue in it is now on the lens, and its 3 s and 10 s start. */
function cueShown(content: string): void {
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
      // The host closed the app while an earlier box was in flight: send nothing more.
      if (stopped) break;
      const cell = cells()[box.name] ?? { content: "", color: LIGHT.ambient };
      const done = await update(box, cell);
      if (done && (box === QUESTION || CARD_LINES.includes(box))) cueShown(cell.content);
      ok = done && ok;
    }
  } finally {
    rendering = false;
  }
  // The lens follows the state: a changed state redraws it at once.
  pipe?.poke();
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
      if (message.text.startsWith("Saved")) toast(`Saved  ·  ${message.text.replace(/^Saved:\s*/, "")}`, 4000);
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
      state.notes = message.notes ?? [];
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
    case "vault_graph":
      state.vault = message.nodes.length > 0 ? buildVault(message) : null;
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
  : connectServer(
      handleServerMessage,
      (connected) => {
        showStatus(connected ? "Connected" : "Disconnected - retrying");
        if (!connected) setMode("connecting");
      },
      // The server sends the vault graph only to a socket that says it is Answers.
      "answers",
    );
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
  feedVoice(voiceLevel(pcm));
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
  // Never open the microphone after an exit.
  if (stopped) return;
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
/** Unsubscribes the early exit listener (see onExit). */
let offExit: (() => void) | null = null;

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  listening = false;
  offExit?.();
  offExit = null;
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
      state.notes = [];
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
      toast("Saving to Obsidian…", 15_000);
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

// ---- The lens ----------------------------------------------------------------

const since = (): number => (performance.now() - iconAt) / 1000;

/** One voice sample from the audio frames. A quiet room wakes the lens when the voice starts. */
function feedVoice(level: number): void {
  const wasActive = voice.active;
  voice.push(level);
  if (!wasActive && voice.active) pipe?.poke();
}

/** Progress of the opening, or null when it is not on. */
const opening = (): number | null => (loadOff ? null : openRatio(state, openAt, performance.now(), loadFrozen));

/** Seconds on the lens clock when the opening is frozen: inside the board's opening, after its 1.6 s logo. */
const frozenT = (r: number): number => 1.6 + r * (OPEN_MS / 1000);

/** The lens's changing parts: the clock, the voice, the opening and the recall entrance. A demo shows the board's own motion. */
function envAt(t: number): Env {
  const r = opening();
  const lensT = r !== null && loadFrozen !== null ? frozenT(r) : t;
  const base: Env = demo && !demoVoice
    ? boardEnv(lensT)
    : { t: lensT, clock: clockText(new Date()), meter: meterOf(voice.history), columns: ribbonColumns(voice.history), open: null, entrance: 1, since: 0, level: voice.level };
  return { ...base, open: r, since: since(), level: demo && !demoVoice ? 0 : voice.level };
}

/** Whether the recall view was up at the last frame, to start its entrance when it appears. */
let recallUp = false;
let lastFps = 2;

/** The lens at `t`: the model for the live state, drawn as the board draws it. */
function lensFrame(t: number): Uint8Array {
  const now = new Date();
  const env = envAt(t);
  let s = screen(state, now, env);
  if (s.recall && !recallUp) recallAt = performance.now();
  recallUp = s.recall !== null;
  if (s.recall) {
    const entrance = Math.min(1, (performance.now() - recallAt) / ENTRANCE_MS);
    if (entrance < 1) s = screen(state, now, { ...env, entrance });
  }
  lastFps = lensFps(s.lens, { icon: iconMoves(iconMode), meter: voice.active });
  const canvas = lensCanvas();
  drawLens(canvas, s.lens, env.t);
  return canvas.pixels;
}

/** The four tiles of the lens. A still lens costs nothing: an unchanged tile is not sent. */
const producers = (): Producer[] => lensTiles(lensFrame, () => lastFps);

// ---- Start -------------------------------------------------------------------

/** The intervals a demo scene starts; stopped with the page. */
const demoTimers: ReturnType<typeof setInterval>[] = [];
/** The demo scene: its state, a sample graph, and (for the cue scenes) a cue that comes back after it ends. */
function seedDemo(name: string): void {
  const sc = scene(name, Date.now());
  Object.assign(state, sc.state);
  if (sc.vault) state.vault = boardVault();
  if (sc.voice) {
    demoVoice = true;
    demoTimers.push(setInterval(() => feedVoice(fakeLevel(Date.now())), 100));
  }
  if (sc.saved) {
    // The server's own words: the page turns them into the toast.
    const arm = (): void => {
      if (!state.toast || state.toast.until < Date.now()) handleServerMessage({ type: "status", text: "Saved: Pricing call with Sarah" });
    };
    arm();
    demoTimers.push(setInterval(arm, 1000));
  }
  if (sc.cue) {
    const arm = (): void => {
      if (!state.cue) handleServerMessage({ type: "recall", ...SARAH, facts: [...SARAH.facts] });
    };
    arm();
    demoTimers.push(setInterval(arm, 1000));
  }
}

async function start(): Promise<void> {
  // `bridge` is set only once the page exists, so no text upgrade goes to a page that is not there yet.
  const host = await waitForEvenAppBridge();
  // Listens from now on, so an exit during the intro or while the page is built is not lost.
  offExit = onExit(host, shutdown);
  // The intro owns the lens first. Nothing else sends to the glasses until it returns.
  const intro = await playSplash(host, { name: "Answers", icon: ICON, order: ORDER });
  if (intro.exited || stopped) return shutdown();
  if (demo) seedDemo(demo);
  // After the intro, so data that arrived during it is on the first page.
  const content = cells();
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is sent again.
  if (await openPage(host, pageSpec(content), intro.startedUp)) {
    for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
    for (const box of [QUESTION, ...CARD_LINES]) cueShown(content[box.name]?.content ?? "");
  } else notePageFailure();
  // The host closed the app while the page was being built: use nothing of it.
  if (stopped) return;
  bridge = host;
  // A state change that came while the page was created (such as the server's greeting) goes on the lens now.
  scheduleRender();
  const unsubscribe = host.onEvenHubEvent(handleGlassesEvent);
  const images = new ImagePipe(host);
  pipe = images;
  images.set(producers());
  void images.run();
  // The opening starts with the live page; it plays only while the state stays plain listening.
  openAt = performance.now();
  // Keeps the clock current, dims old answers and watches the audio.
  const tick = setInterval(() => {
    scheduleRender();
    checkAudio();
  }, 15_000);
  stopPage = () => {
    unsubscribe();
    images.stop();
    clearInterval(tick);
    for (const timer of demoTimers) clearInterval(timer);
  };
  // No microphone in a demo; the page just shows the scene.
  if (demo) return;
  await setListening(true);
}

start().catch((error: unknown) => {
  showStatus(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
});
