import {
  AudioInputSource,
  AudioSpeakerRole,
  OsEventTypeList,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { voiceLevel } from "../core/voice";
import { LENS_TILES, lensTiles } from "../core/board";
import type { Box } from "../core/box";
import { eventTypeOf, onExit } from "../core/events";
import { LIGHT, iconProp, textProp, type Cell } from "../core/hud";
import { ImagePipe } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage, type PageSpec } from "../core/page";
import { speakerCode, type HackView } from "../core/protocol";
import { playSplash } from "../core/splash";
import { clockText, fitBytes } from "../core/text";
import { demoView } from "./demo";
import { ICON, ORDER } from "./icon";
import { BOOT_MS, bootParam, hackFps, renderHack } from "./render";
import {
  BODY_BOX, HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS, TEXT_BOXES, bootScreen, doubleTapAction, hackScreen, stoppable, type HackScreen,
} from "./view";

/**
 * HackOS: talk to your own model. On the glasses, hold to talk; the answer
 * streams onto the lens. In a browser on the Mac, the same page is a terminal:
 * type, or hold Space to talk through the Mac's microphone.
 */

const BUSY = new Set<HackView["state"]>(["waking", "thinking", "answering"]);
const GLASSES_MIC_NOTE = "The glasses microphone did not start. Reopen HackOS.";
/** A bridge call that gives no answer in this time counts as failed, so one lost answer cannot stop the display. */
const BRIDGE_TIMEOUT_MS = 5000;
const MAC_MIC_NOTE = "The microphone is not available. Allow it for this page, or type.";

/** `?demo=<scene>`: a fixed screen with no server, for the glasses page only. */
const demo = new URLSearchParams(location.search).get("demo");
let view: HackView | null = demo ? demoView(demo) : null;
let page = 0;
let holding = false;
/** Set only when the glasses page exists; in a plain browser (the Mac terminal) it stays null. */
let bridge: EvenAppBridge | null = null;
/** From the connection, such as a missing pairing key; cleared when a connection opens. */
let keyNote = "";
/** A microphone that did not open; cleared by the next hold or the next state change. */
let micNote = "";
const notice = () => keyNote || micNote;
/** When the newest state last left a stoppable state (see doubleTapAction). */
let endedAt = 0;
/** Counts presses and releases, so a slow microphone start can tell that it is stale. */
let talkAttempt = 0;
/** Ends a hold that lasts MAX_HOLD_MS. */
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** The lens is one picture: it is drawn from the latest screen. */
let latest: HackScreen = hackScreen(null, 0, new Date());
/** The opening (the core boots): when it began, and which state it began in. */
let bootAt: number | null = null;
let bootState: HackView["state"] | null = null;
/** The opening plays once, when the first view arrives after the page opened: this is set then. */
let bootDecided = false;
const bootOptions = bootParam(location.search);
/** A smoothed voice level, 0 to 1, for the recording core and icon. */
let level = 0;
let target = 0;
let pipe: ImagePipe | null = null;
/** The time at which a still lens turns its core, so a core at rest draws the same frame every time. */
const REST_T = 2;
const shown = new Map<string, Cell>();

// ---- Terminal page (the Mac interface; also the phone page) -------------------

const termEl = document.getElementById("term");
const statusEl = document.getElementById("status");
const talkEl = document.getElementById("talk");

function line(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function statusText(v: HackView | null): string {
  if (!v) return "connecting…";
  const seconds = v.startedAt ? `  ·  ${Math.max(0, Math.round((Date.now() - v.startedAt) / 1000))}s` : "";
  switch (v.state) {
    case "off": return "setup needed";
    case "recording": return "listening  ·  release to send";
    case "transcribing": return "transcribing";
    case "waking": return `waking the GPU${seconds}  ·  the first answer takes about a minute`;
    case "thinking": return `thinking${seconds}`;
    case "answering": return "answering";
    case "error": return "error";
    default: return `ready  ·  ${v.model}${v.stats ? `  ·  ${v.stats}` : ""}`;
  }
}

function terminal(): void {
  if (statusEl) statusEl.textContent = notice() || statusText(view);
  if (talkEl) talkEl.classList.toggle("on", holding);
  if (!termEl) return;
  if (!view) {
    if (keyNote) termEl.replaceChildren(line("err", keyNote));
    return;
  }
  const atBottom = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 40;
  const rows: HTMLElement[] = [];
  // The current turn is the last history entry once it is done; do not show it twice.
  const current = BUSY.has(view.state) || view.state === "error" || (view.state === "done" && view.stats === "stopped");
  for (const turn of view.history) rows.push(line("you", turn.prompt), line("model", turn.answer));
  if (current && view.prompt) {
    rows.push(line("you", view.prompt));
    if (view.answer) rows.push(line(view.state === "answering" ? "model live" : "model", view.answer));
  }
  if (view.error) rows.push(line("err", view.error));
  if (rows.length === 0) rows.push(line("hint", "Type a message, or hold Space to talk."));
  termEl.replaceChildren(...rows);
  if (atBottom) termEl.scrollTop = termEl.scrollHeight;
}

// ---- Glasses -----------------------------------------------------------------

let renderTimer: ReturnType<typeof setTimeout> | null = null;
/** Set by shutdown(): the app was closed on the glasses. */
let stopped = false;
function scheduleRender(): void {
  if (renderTimer || stopped) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void render();
  }, 150);
}

/** The opening's progress, 0 to 1; 1 when it is not playing. Ends itself when its time is up. */
function reveal(): number {
  if (bootAt === null) return 1;
  if (bootOptions.frozen !== null) return bootOptions.frozen;
  const r = (Date.now() - bootAt) / BOOT_MS;
  if (r >= 1) bootAt = null;
  return Math.min(1, r);
}

/** The screen for now. Also starts and ends the opening. */
function screen(): HackScreen {
  let s = hackScreen(view, page, new Date(), notice());
  page = s.page;
  // A hold shows at once, before the server's own "recording" arrives.
  if (holding) s = { ...s, mode: "recording" };
  // The core boots once, when the first view arrives (after the page opened) and the app is at rest.
  if (view && pipe && !bootDecided) {
    bootDecided = true;
    if (s.mode === "idle" && !bootOptions.off) {
      bootAt = Date.now();
      bootState = view.state;
    }
  }
  // Any other state, and any note, ends it at once.
  if (bootAt !== null && (s.mode !== "idle" || view?.state !== bootState || notice() || view?.error)) bootAt = null;
  if (bootAt !== null && s.layout === "answer") s = bootScreen(s);
  latest = s;
  return s;
}

const cellsOf = (s: HackScreen): Record<string, Cell> => ({
  status: s.status, prompt: s.prompt, body: s.body, sentence: s.sentence, hint: s.hint,
});

/** What the picture shows, apart from time: when it changes the pipe draws again at once. */
const pictureKey = (s: HackScreen): string => JSON.stringify([s.mode, s.layout, s.footer, s.speed, s.bars, s.seconds, clockText(new Date()), reveal() < 1]);
let lastKey = "";

/** One lens frame from the latest screen, at pipe time `t`. */
function lens(t: number): Uint8Array {
  level += (target - level) * 0.35;
  target *= 0.8;
  const r = reveal();
  const s = latest;
  const still = !demo && r >= 1 && (s.mode === "idle" || s.mode === "off" || s.mode === "recording");
  return renderHack(s, { t: still ? REST_T : t, clock: clockText(new Date()), reveal: r, level });
}

const lensFps = (): number => hackFps(latest, reveal(), !!demo);

/** One fixed page for every state, so nothing is rebuilt (a rebuild flickers). The lens is four image tiles behind, the text in front: every container sets zOrderIndex. */
function layout(s: HackScreen): PageSpec {
  const cells = cellsOf(s);
  return {
    containerTotalNum: LENS_TILES.length + TEXT_BOXES.length,
    imageObject: LENS_TILES.map((box, i) => Object.assign(iconProp(box), { zOrderIndex: i + 1 })),
    textObject: TEXT_BOXES.map((box, i) =>
      textProp(box, cells[box.name] ?? { content: "", color: LIGHT.ambient }, { zOrderIndex: 10 + i, ...(box === BODY_BOX ? { isEventCapture: 1 } : {}) }),
    ),
  };
}

/** A bridge call that fails, throws or gives no answer in time is a call that did not reach the glasses. */
function capped(call: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), BRIDGE_TIMEOUT_MS);
  });
  return Promise.race([call.catch(() => false), timeout]).finally(() => clearTimeout(timer));
}

async function update(box: Box, cell: Cell): Promise<void> {
  const next = { content: fitBytes(cell.content), color: cell.color };
  const prev = shown.get(box.name);
  // After a system exit nothing more goes to the glasses.
  if (!bridge || stopped || (prev && prev.content === next.content && (next.content === "" || prev.color === next.color))) return;
  shown.set(box.name, next);
  const ok = await capped(
    bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: next.content, textColor: next.color })),
  );
  // Not on the glasses: forget it, so the next render (at most 1 s later) sends it again.
  if (!ok && shown.get(box.name) === next) shown.delete(box.name);
}

let rendering = false;
let renderAgain = false;

/** One pass at a time. A pass asked for during another runs after it, so an older pass never sends its text after a newer one. */
async function render(): Promise<void> {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    do {
      renderAgain = false;
      const next = cellsOf(screen());
      const key = pictureKey(latest);
      if (key !== lastKey) {
        lastKey = key;
        pipe?.poke();
      }
      for (const box of TEXT_BOXES) await update(box, next[box.name] ?? { content: "", color: LIGHT.ambient });
      // The app was closed during this pass: start no other.
    } while (renderAgain && !stopped);
  } finally {
    rendering = false;
  }
}

const none: Server = { send: () => undefined, sendBinary: () => undefined, isOpen: () => false, close: () => undefined };
const server: Server = demo ? none : connectServer(
  (message) => {
    if (message.type === "error") {
      keyNote = message.message;
      terminal();
      scheduleRender();
      return;
    }
    if (message.type !== "hack") return;
    if (message.data.prompt !== view?.prompt || BUSY.has(message.data.state)) page = 0;
    if (stoppable(view) && !stoppable(message.data)) endedAt = Date.now();
    // Not on the way out of "recording": that is the server's answer to the hold this note is about.
    if (view && message.data.state !== view.state && view.state !== "recording") micNote = "";
    view = message.data;
    terminal();
    scheduleRender();
  },
  (connected) => {
    // A note about an old hold does not belong to the new connection, nor to the disconnected state.
    micNote = "";
    if (connected) keyNote = "";
    else {
      view = null;
      // The audio has nowhere to go. The server drops the hold and shows the note after the reconnect.
      dropHold("");
    }
    terminal();
    scheduleRender();
  },
  "hackos",
);

// ---- Microphone on the Mac (in a browser, without the glasses) ----------------

let mic: { stop: () => void } | null = null;

async function micStart(attempt: number): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  if (attempt !== talkAttempt) {
    stream.getTracks().forEach((t) => t.stop()); // released (or pressed again) before the microphone opened
    return;
  }
  const context = new AudioContext({ sampleRate: 16_000 });
  const source = context.createMediaStreamSource(stream);
  const node = context.createScriptProcessor(4096, 1, 1);
  const self = speakerCode("self");
  node.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    const frame = new Uint8Array(1 + samples.length * 2);
    frame[0] = self;
    const data = new DataView(frame.buffer);
    for (let i = 0; i < samples.length; i++) data.setInt16(1 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767), true);
    hear(voiceLevel(frame.subarray(1)));
    server.sendBinary(frame);
  };
  source.connect(node);
  node.connect(context.destination);
  mic = {
    stop: () => {
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
  };
}

/** Your voice level, from the glasses microphone or this computer's. */
function hear(heard: number): void {
  target = Math.max(target, Math.max(0, Math.min(1, heard)));
}

// ---- Input -------------------------------------------------------------------

/** A press starts a hold, a release ends it and sends what was heard; `discard` ends it and drops what was heard. */
async function talk(on: boolean, discard = false): Promise<void> {
  // Also while the last hold is transcribed: the server refuses that press.
  if (on && (!view || view.state === "off" || view.state === "transcribing" || BUSY.has(view.state))) return;
  if (on && holding) {
    // A press while holding: the release of this hold was lost. The server starts over, without what it heard.
    server.send({ type: "hack_ptt", on: true });
    startHoldTimer();
    return;
  }
  if (on === holding) return;
  holding = on;
  if (on) startHoldTimer();
  else if (holdTimer) clearTimeout(holdTimer);
  const attempt = ++talkAttempt;
  if (on) micNote = "";
  terminal();
  scheduleRender();
  // The microphone is open only while you hold.
  if (on) {
    const glasses = bridge;
    // audioControl resolves false (it does not throw) when the host refuses the microphone.
    const open = glasses
      ? await glasses.audioControl(true, AudioInputSource.Glasses).catch(() => false)
      : await micStart(attempt).then(() => true, () => false);
    if (attempt !== talkAttempt) return; // released while the microphone opened
    if (!open) {
      holding = false;
      micNote = glasses ? GLASSES_MIC_NOTE : MAC_MIC_NOTE;
      terminal();
      scheduleRender();
      return;
    }
    // Only now, so a microphone that did not open does not end in "Didn't catch that".
    server.send({ type: "hack_ptt", on: true });
    return;
  }
  // First, so an audioControl that fails or hangs cannot keep the release from the server.
  server.send({ type: "hack_ptt", on: false, ...(discard ? { discard: true } : {}) });
  mic?.stop();
  mic = null;
  if (bridge) await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false);
}

function startHoldTimer(): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => dropHold(HOLD_LIMIT_NOTE), MAX_HOLD_MS);
}

/** Ends a hold whose release cannot come (an exit, the time limit, a lost connection): the microphone closes and nothing is sent. */
function dropHold(note: string): void {
  if (!holding) return;
  micNote = note;
  void talk(false, true);
}

function stopOrNew(): void {
  const action = doubleTapAction(view, endedAt, Date.now());
  if (action) server.send({ type: action });
}

document.getElementById("ask")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("prompt") as HTMLInputElement | null;
  const text = input?.value.trim();
  if (!text || !input) return;
  server.send({ type: "hack_prompt", text });
  input.value = "";
});
document.getElementById("stop")?.addEventListener("click", () => server.send({ type: "hack_stop" }));
document.getElementById("new")?.addEventListener("click", () => server.send({ type: "hack_new" }));
talkEl?.addEventListener("pointerdown", () => void talk(true));
talkEl?.addEventListener("pointerup", () => void talk(false));
talkEl?.addEventListener("pointerleave", () => void talk(false));

// Hold Space to talk, unless you are typing.
const typing = () => document.activeElement instanceof HTMLInputElement && document.activeElement.value !== "";
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || typing()) return;
  event.preventDefault();
  void talk(true);
});
document.addEventListener("keyup", (event) => {
  if (event.code === "Space" && holding) void talk(false);
});
// A keyup that goes to another window is lost: close the Mac microphone when the page loses focus.
window.addEventListener("blur", () => {
  if (holding && !bridge) void talk(false);
});
// The page is going away: close the microphone (as the official ASR template does).
window.addEventListener("pagehide", () => dropHold(""));

function onEvent(event: EvenHubEvent): void {
  if (event.audioEvent) {
    if (!holding) return;
    const { audioPcm, speakerRole } = event.audioEvent;
    hear(voiceLevel(audioPcm));
    const frame = new Uint8Array(audioPcm.length + 1);
    frame[0] = speakerCode(speakerRole === AudioSpeakerRole.Other ? "other" : speakerRole === AudioSpeakerRole.Self ? "self" : "unknown");
    frame.set(audioPcm, 1);
    server.sendBinary(frame);
    return;
  }
  switch (eventTypeOf(event)) {
    case OsEventTypeList.LONG_PRESS_EVENT:
      void talk(true);
      break;
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      void talk(false);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      // The system menu took over: a release may never reach this page.
      dropHold(HOLD_DROPPED_NOTE);
      break;
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      shutdown();
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      stopOrNew();
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
      page = Math.max(0, page - 1);
      scheduleRender();
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      page += 1;
      scheduleRender();
      break;
    default:
      break;
  }
}

/** Set by start(): stops what start() began. */
let stopPage: (() => void) | null = null;
/** Unsubscribes the early exit listener (see onExit). */
let offExit: (() => void) | null = null;

/** The host is closing the app. The WebView can outlive this event, so release everything here (as Answers does). */
function shutdown(): void {
  if (stopped) return;
  // Sends the discard and closes the microphone before the socket closes.
  dropHold("");
  stopped = true;
  offExit?.();
  offExit = null;
  stopPage?.();
  clearInterval(tick);
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  server.close();
}

async function start(): Promise<void> {
  // The SDK returns a bridge in any browser, also with no Even app around it.
  const host = await waitForEvenAppBridge();
  // Listens from now on, so an exit during the intro or while the page is built is not lost.
  offExit = onExit(host, shutdown);
  // The intro owns the lens first. Nothing else sends to the glasses until it returns.
  const intro = await playSplash(host, { name: "HackOS", icon: ICON, order: ORDER });
  if (intro.exited || stopped) return shutdown();
  // After the intro, so data that arrived during it is on the first page.
  const first = screen();
  const opened = await openPage(host, layout(first), intro.startedUp);
  // The host closed the app while the page was being built.
  if (stopped) return;
  // No page and no Even app (the SDK needs window.flutter_inappwebview): a plain browser, the
  // Mac terminal. `bridge` stays null, so talk() uses this computer's microphone.
  if (!opened && !("flutter_inappwebview" in window)) return;
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is sent again.
  if (opened) {
    for (const [name, cell] of Object.entries(cellsOf(first))) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
  } else notePageFailure();
  // Only now: text updates and the glasses microphone need the page.
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  const images = new ImagePipe(bridge);
  pipe = images;
  images.set(lensTiles(lens, lensFps));
  void images.run();
  // The first view may be here already.
  void render();
  // A demo has no microphone: the recording scene plays a made-up voice.
  const voice = demo === "recording" ? setInterval(() => hear(0.5 + 0.5 * Math.sin(Date.now() / 450)), 200) : null;
  stopPage = () => {
    unsubscribe();
    images.stop();
    if (voice) clearInterval(voice);
  };
}

// Ticks the elapsed time and the clock, on the glasses and in the terminal.
const tick = setInterval(() => {
  terminal();
  scheduleRender();
}, 1000);
terminal();
void start();
