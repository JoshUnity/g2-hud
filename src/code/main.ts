import {
  AudioInputSource,
  AudioSpeakerRole,
  ImageContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { voiceLevel } from "../answers/animator";
import { CARD, CLOCK, LIGHT, QUESTION, SIGIL, STATUS, fitBytes, type Cell } from "../answers/hud";
import type { Box } from "../core/box";
import { eventTypeOf } from "../core/events";
import { ImagePipe } from "../core/imagepipe";
import { connectServer } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import { speakerCode, type CodeHub, type CodeView } from "../core/protocol";
import { CodeMark } from "./mark";
import {
  ALLOW_DELAY_MS,
  HOLD_DROPPED_NOTE,
  HOLD_LIMIT_NOTE,
  MAX_HOLD_MS,
  busy,
  canAllow,
  codeScreen,
  doubleTapAction,
  menuLabel,
  seenAfterRender,
  tabStrip,
  type ApprovalRef,
  type CodeScreen,
  type SeenApproval,
} from "./view";

/**
 * Code: speak instructions to Claude Code on your Mac, in tabs (one session per
 * tab). Hold to talk, tap to allow, double tap to deny or stop, tap then hold
 * for the tab menu.
 */

const TEXT_BOXES: Box[] = [STATUS, CLOCK, QUESTION, CARD];
const NEW_TAB = 900;
const CLOSE_TAB = 901;
const MIC_NOTE = "The glasses microphone did not start. Reopen Code.";
/** A bridge call that gives no answer in this time counts as failed, so one lost answer cannot stop the display. */
const BRIDGE_TIMEOUT_MS = 5000;
/** A menu rebuild that failed is tried again after this time (not on every render). */
const MENU_RETRY_MS = 2000;

let hub: CodeHub | null = null;
let active = -1;
let page = 0;
let holding = false;
/** Set only when the glasses page exists. */
let bridge: EvenAppBridge | null = null;
let pipe: ImagePipe | null = null;
/** The tab menu on the glasses; empty when it is not known to be there. */
let menuKey = "";
let menuRetryAt = 0;
/** From the connection, such as a missing pairing key; cleared when a connection opens. */
let keyNote = "";
/** A microphone that did not open; cleared by the next hold or the next state change. */
let micNote = "";
const notice = () => keyNote || micNote;
/** Counts presses and releases, so a slow microphone start can tell that it is stale. */
let talkAttempt = 0;
/** Ends a hold that lasts MAX_HOLD_MS. */
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** When the active tab last went from a busy state to rest (see doubleTapAction). */
let restSince = 0;
/** The approval card on the glasses (see seenAfterRender). */
let seen: SeenApproval | null = null;
/** A tap that will allow after ALLOW_DELAY_MS, unless a double tap or a hold comes first. */
let pendingAllow: (ApprovalRef & { timer: ReturnType<typeof setTimeout> }) | null = null;
const mark = new CodeMark(SIGIL);
const shown = new Map<string, Cell>();

const activeView = (): CodeView | null => hub?.tabs.find((t) => t.id === active)?.view ?? null;

// ---- Phone page --------------------------------------------------------------

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const approvalEl = document.getElementById("approval");
const tabsEl = document.getElementById("tabs");
const notesEl = document.getElementById("notes");

function phone(): void {
  const view = activeView();
  if (tabsEl) {
    tabsEl.replaceChildren(
      ...(hub?.tabs ?? []).map((t, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${i + 1} ${t.view.project}${t.view.state === "approval" ? " !" : ""}`;
        b.style.opacity = t.id === active ? "1" : "0.5";
        b.addEventListener("click", () => selectTab(t.id));
        return b;
      }),
    );
  }
  if (notesEl) {
    // A setup error of the hub (such as a CODE_DIRS folder that does not exist) shows even when tabs exist.
    const notes = [keyNote, micNote, hub?.error ?? ""].filter(Boolean).join("\n");
    notesEl.textContent = notes;
    notesEl.hidden = !notes;
  }
  if (approvalEl) approvalEl.hidden = !view?.approval;
  if (!view) {
    if (statusEl) statusEl.textContent = keyNote ? "Not connected" : hub ? "CODE  ·  SETUP" : "Connecting…";
    return;
  }
  if (statusEl) statusEl.textContent = `${view.state.toUpperCase()}  ·  ${view.project}${view.stats ? `  ·  ${view.stats}` : ""}`;
  if (logEl) logEl.textContent = [view.prompt && `> ${view.prompt}`, ...view.log, view.result && `\n${view.result}`, view.error].filter(Boolean).join("\n");
  // The whole call, with its line breaks (see #approval code in index.html).
  const code = approvalEl?.querySelector("code");
  if (code) code.textContent = view.approval?.text ?? "";
}

// ---- Glasses -----------------------------------------------------------------

let renderTimer: ReturnType<typeof setTimeout> | null = null;
/** Set by shutdown(): the app was closed. */
let stopped = false;
function scheduleRender(): void {
  if (renderTimer || stopped) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void render();
  }, 150);
}

function screenNow(): CodeScreen {
  const view = activeView();
  let s: CodeScreen;
  if (hub && !view && hub.error) s = codeScreen({ ...emptyView, state: "off", error: hub.error }, 0, new Date());
  else {
    // A hub error (a CODE_DIRS folder that did not open) also shows when tabs exist, but never hides the tab's own error.
    const shownView = view && !view.error && hub?.error ? { ...view, error: hub.error } : view;
    s = codeScreen(shownView, page, new Date(), tabStrip(hub, active), notice());
  }
  page = s.page;
  mark.setMode(holding ? "recording" : s.mark);
  return s;
}

const cellsOf = (s: CodeScreen): Record<string, Cell> => ({ [STATUS.name]: s.status, [CLOCK.name]: s.clock, [QUESTION.name]: s.question, [CARD.name]: s.card });

const emptyView: CodeView = { state: "off", project: "", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };

function menu(): MenuContainerProperty {
  const items = (hub?.tabs ?? []).map(
    (t, i) => new MenuItemProperty({ itemID: t.id, itemName: menuLabel(i, t.view.project, t.view.state === "approval") }),
  );
  if ((hub?.tabs.length ?? 0) < 6) items.push(new MenuItemProperty({ itemID: NEW_TAB, itemName: "+  New tab" }));
  if ((hub?.tabs.length ?? 0) > 1) items.push(new MenuItemProperty({ itemID: CLOSE_TAB, itemName: "×  Close this tab" }));
  return new MenuContainerProperty({ menuItems: items });
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
    menuObject: menu(),
  };
}

/** The menu lists the tabs, so it is rebuilt (with the page) when they change. */
const keyOfMenu = () => (hub?.tabs ?? []).map((t) => `${t.id}:${t.view.project}:${t.view.state === "approval"}`).join("|");

/** A bridge call that fails, throws or gives no answer in time is a call that did not reach the glasses. */
function capped(call: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), BRIDGE_TIMEOUT_MS);
  });
  return Promise.race([call.catch(() => false), timeout]).finally(() => clearTimeout(timer));
}

async function rebuildIfMenuChanged(): Promise<void> {
  const key = keyOfMenu();
  if (!bridge || key === menuKey || Date.now() < menuRetryAt) return;
  const content = cellsOf(screenNow());
  pipe?.set([]);
  const ok = await capped(bridge.rebuildPageContainer(new RebuildPageContainer(layout(content))));
  shown.clear();
  if (ok) {
    menuKey = key;
    for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
  } else menuRetryAt = Date.now() + MENU_RETRY_MS; // the 1 s tick tries again
  pipe?.set([mark.producer()]);
}

/** True when the cell is on the glasses: unchanged, or sent and confirmed. */
async function update(box: Box, cell: Cell): Promise<boolean> {
  const next = { content: fitBytes(cell.content), color: cell.color };
  const prev = shown.get(box.name);
  if (!bridge) return false;
  if (prev && prev.content === next.content && prev.color === next.color) return true;
  shown.set(box.name, next);
  const ok = await capped(
    bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: next.content, textColor: next.color })),
  );
  // Not on the glasses: forget it, so the next render (at most 1 s later) sends it again.
  if (!ok && shown.get(box.name) === next) shown.delete(box.name);
  return ok;
}

let rendering = false;
let renderAgain = false;

/** One pass at a time. A pass asked for during another runs after it, so no old text is sent after a rebuild. */
async function render(): Promise<void> {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    do {
      renderAgain = false;
      await rebuildIfMenuChanged();
      // What this pass draws, taken on one tick.
      const tab = active;
      const view = activeView();
      const s = screenNow();
      const next = cellsOf(s);
      let drawn = true;
      for (const box of TEXT_BOXES) if (!(await update(box, next[box.name] ?? { content: "", color: 1 }))) drawn = false;
      seen = seenAfterRender(seen, drawn, tab, view, s, Date.now());
      // The app was closed during this pass: start no other.
    } while (renderAgain && !stopped);
  } finally {
    rendering = false;
  }
}

function selectTab(id: number): void {
  if (id === active || holding) return;
  active = id;
  page = 0;
  phone();
  scheduleRender();
}

const server = connectServer(
  (message) => {
    if (message.type === "error") {
      keyNote = message.message;
      phone();
      scheduleRender();
      return;
    }
    if (message.type !== "code") return;
    const before = activeView();
    hub = message.data;
    if (!hub.tabs.some((t) => t.id === active)) active = hub.tabs[0]?.id ?? -1;
    const after = activeView();
    if (before?.result !== after?.result || before?.approval?.id !== after?.approval?.id) page = 0;
    if (busy(before) && after && !busy(after)) restSince = Date.now();
    // Not on the way out of "recording": that is the server's answer to the hold this note is about.
    if (before && after && before.state !== after.state && before.state !== "recording") micNote = "";
    phone();
    scheduleRender();
  },
  (connected) => {
    if (connected) keyNote = "";
    else {
      hub = null;
      // A restarted server counts tab and request ids from 1 again: what was on the glasses no longer counts.
      seen = null;
      cancelAllow();
      // The audio has nowhere to go. The server drops the hold and shows the note after the reconnect.
      dropHold("");
    }
    phone();
    scheduleRender();
  },
  "code",
);

// Phone controls, handy in the simulator.
document.getElementById("ask")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("prompt") as HTMLInputElement | null;
  const text = input?.value.trim();
  if (!text || !input) return;
  server.send({ type: "code_prompt", tab: active, text });
  input.value = "";
});
// The phone buttons answer the request the phone page shows (updated on the same tick as `hub`).
const decide = (allow: boolean) => {
  const a = activeView()?.approval;
  if (a) server.send({ type: "code_decide", tab: active, id: a.id, allow });
};
document.getElementById("allow")?.addEventListener("click", () => decide(true));
document.getElementById("deny")?.addEventListener("click", () => decide(false));
document.getElementById("stop")?.addEventListener("click", () => server.send({ type: "code_stop", tab: active }));
document.getElementById("new")?.addEventListener("click", () => server.send({ type: "code_new", tab: active }));
document.getElementById("newtab")?.addEventListener("click", () => server.send({ type: "code_tab_open", tab: active }));
// The page is going away: close the glasses microphone (as the official ASR template does).
window.addEventListener("pagehide", () => dropHold(""));

// ---- Input -------------------------------------------------------------------

/** A press starts a hold, a release ends it and runs what was heard; `discard` ends it and drops what was heard. */
async function talk(on: boolean, discard = false): Promise<void> {
  const state = activeView()?.state;
  // Also while the last instruction is transcribed: the server refuses that press.
  if (on && (state === "working" || state === "approval" || state === "transcribing" || state === "off" || !state)) return;
  if (on && holding) {
    // A press while holding: the release of this hold was lost. The server starts over, without what it heard.
    server.send({ type: "code_ptt", tab: active, on: true });
    startHoldTimer();
    return;
  }
  if (on === holding) return;
  holding = on;
  if (on) startHoldTimer();
  else if (holdTimer) clearTimeout(holdTimer);
  const attempt = ++talkAttempt;
  if (on) micNote = "";
  phone();
  scheduleRender();
  // The microphone is open only while you hold.
  if (on) {
    // audioControl resolves false (it does not throw) when the host refuses the microphone.
    const open = bridge ? await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false) : false;
    if (attempt !== talkAttempt) return; // released while the microphone opened
    if (!open) {
      holding = false;
      micNote = MIC_NOTE;
      phone();
      scheduleRender();
      return;
    }
    // Only now, so a microphone that did not open does not end in "Didn't catch that".
    server.send({ type: "code_ptt", tab: active, on: true });
    return;
  }
  // First, so an audioControl that fails or hangs cannot keep the release from the server.
  server.send({ type: "code_ptt", tab: active, on: false, ...(discard ? { discard: true } : {}) });
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

/** Stops a pending allow; returns the request it was for. */
function cancelAllow(): ApprovalRef | null {
  if (!pendingAllow) return null;
  clearTimeout(pendingAllow.timer);
  const { tab, id } = pendingAllow;
  pendingAllow = null;
  return { tab, id };
}

/** A tap: allow the request on the glasses, after ALLOW_DELAY_MS and only if it is still there then. */
function tapAllow(): void {
  if (pendingAllow || !seen || !canAllow(seen, active, activeView(), page, Date.now())) return;
  const { tab, id } = seen;
  pendingAllow = {
    tab,
    id,
    timer: setTimeout(() => {
      pendingAllow = null;
      if (seen?.tab !== tab || seen.id !== id || !canAllow(seen, active, activeView(), page, Date.now())) return;
      server.send({ type: "code_decide", tab, id, allow: true });
    }, ALLOW_DELAY_MS),
  };
}

function onEvent(event: EvenHubEvent): void {
  if (event.audioEvent) {
    if (!holding) return;
    const { audioPcm, speakerRole } = event.audioEvent;
    mark.setLevel(voiceLevel(audioPcm));
    const frame = new Uint8Array(audioPcm.length + 1);
    frame[0] = speakerCode(speakerRole === AudioSpeakerRole.Other ? "other" : speakerRole === AudioSpeakerRole.Self ? "self" : "unknown");
    frame.set(audioPcm, 1);
    server.sendBinary(frame);
    return;
  }
  if (event.menuItemClickEvent) {
    cancelAllow();
    const id = event.menuItemClickEvent.itemID ?? 0;
    if (id === NEW_TAB) server.send({ type: "code_tab_open", tab: active });
    else if (id === CLOSE_TAB) server.send({ type: "code_tab_close", tab: active });
    // An old menu can still list a tab that was closed.
    else if (hub?.tabs.some((t) => t.id === id)) selectTab(id);
    return;
  }
  const view = activeView();
  switch (eventTypeOf(event)) {
    case OsEventTypeList.LONG_PRESS_EVENT:
      // "Tap, then hold" opens the system menu: its tap is not an allow, and the hold is not talk.
      if (cancelAllow()) break;
      void talk(true);
      break;
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      void talk(false);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      // The system menu took over: a release may never reach this page. The tap was not an allow either.
      cancelAllow();
      dropHold(HOLD_DROPPED_NOTE);
      break;
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      shutdown();
      break;
    case OsEventTypeList.CLICK_EVENT:
      tapAllow();
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT: {
      // A double tap can follow the tap of its own first touch: deny the request that tap was for.
      const action = doubleTapAction(cancelAllow() ?? seen, active, view, restSince, Date.now());
      if (action) server.send(action);
      break;
    }
    case OsEventTypeList.SCROLL_TOP_EVENT:
      page = Math.max(0, page - 1);
      scheduleRender();
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      page += 1;
      scheduleRender();
      break;
    default:
      // Any other system event (such as the menu overlay opening after "tap, then hold"): the tap was not an allow.
      cancelAllow();
      break;
  }
}

/** Set by start(): stops what start() began. */
let stopPage: (() => void) | null = null;

/** The host is closing the app. The WebView can outlive this event, so release everything here (as Answers does). */
function shutdown(): void {
  if (stopped) return;
  cancelAllow();
  // Sends the discard and closes the microphone before the socket closes.
  dropHold("");
  stopped = true;
  stopPage?.();
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  server.close();
}

async function start(): Promise<void> {
  const host = await waitForEvenAppBridge();
  const content = cellsOf(screenNow());
  const key = keyOfMenu();
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is
  // sent again, and `menuKey` stays empty, so the menu is rebuilt.
  if (await openPage(host, layout(content))) {
    menuKey = key;
    for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
  } else notePageFailure();
  // Only now: text updates, menu rebuilds and the microphone need the page.
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  pipe = new ImagePipe(bridge);
  pipe.set([mark.producer()]);
  void pipe.run();
  // Ticks the elapsed time and the clock.
  const tick = setInterval(scheduleRender, 1000);
  stopPage = () => {
    unsubscribe();
    pipe?.stop();
    clearInterval(tick);
  };
  // A hub message that arrived while the page was created.
  scheduleRender();
}

void start();
