import {
  AudioInputSource,
  AudioSpeakerRole,
  ImageContainerProperty,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { Sigil, voiceLevel } from "../answers/animator";
import { CARD, CLOCK, LIGHT, QUESTION, SIGIL, STATUS, fitBytes, type Cell } from "../answers/hud";
import type { Box } from "../core/box";
import { eventTypeOf } from "../core/events";
import { ImagePipe } from "../core/imagepipe";
import { connectServer } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import { speakerCode, type HackView } from "../core/protocol";
import { HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS, doubleTapAction, hackScreen, stoppable } from "./view";

/**
 * HackOS: talk to your own model. On the glasses, hold to talk; the answer
 * streams onto the lens. In a browser on the Mac, the same page is a terminal:
 * type, or hold Space to talk through the Mac's microphone.
 */

const TEXT_BOXES: Box[] = [STATUS, CLOCK, QUESTION, CARD];
const BUSY = new Set<HackView["state"]>(["waking", "thinking", "answering"]);
const GLASSES_MIC_NOTE = "The glasses microphone did not start. Reopen HackOS.";
/** A bridge call that gives no answer in this time counts as failed, so one lost answer cannot stop the display. */
const BRIDGE_TIMEOUT_MS = 5000;
const MAC_MIC_NOTE = "The microphone is not available. Allow it for this page, or type.";

let view: HackView | null = null;
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
const sigil = new Sigil(SIGIL);
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

function cells(): Record<string, Cell> {
  const s = hackScreen(view, page, new Date(), notice());
  page = s.page;
  sigil.setMode(holding ? "listening" : s.sigil);
  return { [STATUS.name]: s.status, [CLOCK.name]: s.clock, [QUESTION.name]: s.question, [CARD.name]: s.card };
}

function layout(content: Record<string, Cell>) {
  const text = (box: Box, extra: Partial<TextContainerProperty> = {}) => {
    const cell = content[box.name] ?? { content: "", color: LIGHT.secondary };
    return new TextContainerProperty({
      xPosition: box.x, yPosition: box.y, width: box.width, height: box.height, containerID: box.id, containerName: box.name,
      content: fitBytes(cell.content), textColor: cell.color, paddingLength: 0, isEventCapture: 0, ...extra,
    });
  };
  return {
    containerTotalNum: 5,
    imageObject: [
      new ImageContainerProperty({ xPosition: SIGIL.x, yPosition: SIGIL.y, width: SIGIL.width, height: SIGIL.height, containerID: SIGIL.id, containerName: SIGIL.name }),
    ],
    textObject: [
      text(STATUS),
      text(CLOCK),
      text(QUESTION),
      text(CARD, { borderWidth: 1, borderColor: 5, borderRadius: 8, paddingLength: 8, isEventCapture: 1 }),
    ],
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
  if (!bridge || (prev && prev.content === next.content && prev.color === next.color)) return;
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
      const next = cells();
      for (const box of TEXT_BOXES) await update(box, next[box.name] ?? { content: "", color: 1 });
      // The app was closed during this pass: start no other.
    } while (renderAgain && !stopped);
  } finally {
    rendering = false;
  }
}

const server = connectServer(
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
    sigil.setLevel(voiceLevel(frame.subarray(1)));
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
    sigil.setLevel(voiceLevel(audioPcm));
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

/** The host is closing the app. The WebView can outlive this event, so release everything here (as Answers does). */
function shutdown(): void {
  if (stopped) return;
  // Sends the discard and closes the microphone before the socket closes.
  dropHold("");
  stopped = true;
  stopPage?.();
  clearInterval(tick);
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  server.close();
}

async function start(): Promise<void> {
  // The SDK returns a bridge in any browser, also with no Even app around it.
  const host = await waitForEvenAppBridge();
  const content = cells();
  const opened = await openPage(host, layout(content));
  // No page and no Even app (the SDK needs window.flutter_inappwebview): a plain browser, the
  // Mac terminal. `bridge` stays null, so talk() uses this computer's microphone.
  if (!opened && !("flutter_inappwebview" in window)) return;
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is sent again.
  if (opened) {
    for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
  } else notePageFailure();
  // Only now: text updates and the glasses microphone need the page.
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  const pipe = new ImagePipe(bridge);
  pipe.set([sigil.producer()]);
  void pipe.run();
  stopPage = () => {
    unsubscribe();
    pipe.stop();
  };
}

// Ticks the elapsed time and the clock, on the glasses and in the terminal.
const tick = setInterval(() => {
  terminal();
  scheduleRender();
}, 1000);
terminal();
void start();
