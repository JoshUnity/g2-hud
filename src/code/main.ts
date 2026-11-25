import {
  AudioInputSource,
  AudioSpeakerRole,
  ImageContainerProperty,
  ImageRawDataUpdateResult,
  type ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { LENS_TILES, lensCanvas, lensTiles } from "../core/board";
import { sameFrame } from "../core/pixels";
import type { Box } from "../core/box";
import { eventTypeOf, onExit } from "../core/events";
import { LIGHT, textProp, type Cell } from "../core/hud";
import { ImagePipe, type Producer } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage, type PageSpec } from "../core/page";
import { speakerCode, type CodeHub, type CodeView } from "../core/protocol";
import { playSplash } from "../core/splash";
import { fitBytes } from "../core/text";
import { voiceLevel } from "../core/voice";
import { demoHub, demoMoment } from "./demo";
import { iconFps } from "./glyph";
import { ICON, ORDER } from "./icon";
import { BODY, CALL, FOLDER, HINT, PROMPT, STATUS, STEP, STEPS, TEXT_BOXES } from "./layout";
import { MOUNT_MS, renderCodeLens } from "./lens";
import { buildLens, liveInput } from "./model";
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
  tabStates,
  type ApprovalRef,
  type CodeScreen,
  type SeenApproval,
} from "./view";

/**
 * Code: speak instructions to Claude Code on your Mac, in tabs (one session per
 * tab). Hold to talk, tap to allow, double tap to deny or stop, tap then hold
 * for the tab menu.
 *
 * One fixed page for every state: the lens is a single raster in four image tiles (lens.ts, the board's drawing)
 * and the glasses font sits in eight text containers on top (layout.ts). An approval is the card in the raster and
 * its call in a text container, so the page is never rebuilt for one.
 */

const NEW_TAB = 900;
const CLOSE_TAB = 901;
const MIC_NOTE = "The glasses microphone did not start. Reopen Code.";
/** A bridge call that gives no answer in this time counts as failed, so one lost answer cannot stop the display. */
const BRIDGE_TIMEOUT_MS = 5000;
/** A page rebuild that failed is tried again after this time (not on every render). */
const MENU_RETRY_MS = 2000;

const search = typeof location === "undefined" ? "" : location.search;
/** `?demo=<scene>`: a scene without the server, a pairing key or a microphone (see demo.ts). */
const demoScene = new URLSearchParams(search).get("demo");
const demo = demoScene !== null;
/** `?load=<0..1>` freezes the map's opening at that progress (for screenshots), `?load=off` skips it. `intro=0` does not affect it. */
const loadParam = new URLSearchParams(search).get("load");
const loadOff = loadParam === "off";
const loadFrozen = loadParam !== null && !loadOff && loadParam.trim() !== "" && Number.isFinite(Number(loadParam)) ? Math.max(0, Math.min(1, Number(loadParam))) : null;
/** The project whose map is opening (tab and name), and since when. The opening plays when a tab's tree first shows. */
let mountKey = "";
let mountAt: number | null = null;
let wasMounting = false;

let hub: CodeHub | null = demo ? demoHub(demoScene) : null;
let active = hub?.tabs[0]?.id ?? -1;
let page = 0;
/**
 * Counts what makes an accepted approval stale: a disconnect, a rebuild, a change of page. A render pass writes
 * `seen` only if this is the number it started with, so a slow pass cannot bring back what a change cleared.
 */
let generation = 0;
/** Changes the page and clears what was accepted for the old one. */
function setPage(next: number): void {
  if (next === page) return;
  page = next;
  seen = null;
  generation++;
}
let holding = false;
/** Set only when the glasses page exists. */
let bridge: EvenAppBridge | null = null;
let pipe: ImagePipe | null = null;
/** The tab menu the glasses page was built with; empty when it is not known to be there. */
let pageKey = "";
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
/** The approval call on the glasses (see seenAfterRender), and the call text that was accepted with it. */
let seen: SeenApproval | null = null;
let seenText: string | undefined;
/** A tap that will allow after ALLOW_DELAY_MS, unless a double tap or a hold comes first. */
let pendingAllow: (ApprovalRef & { timer: ReturnType<typeof setTimeout> }) | null = null;
/** When each request first reached this page, so the countdown bar never shows more time than the server has left. */
const arrivals = new Map<string, { at: number; text: string }>();
/** The highest request id seen per tab: an id below it means the server restarted and counts from 1 again. */
const highestId = new Map<number, number>();
/** The screen the last pass drew; the picture reads it. */
let latest: CodeScreen = codeScreen(null, 0, new Date());
const shown = new Map<string, Cell>();
/** The voice level of the hold, smoothed, for the recording icon. */
let level = 0;
let levelTarget = 0;
let iconNow = "";
let sceneNow = "";

const activeView = (): CodeView | null => hub?.tabs.find((t) => t.id === active)?.view ?? null;

/** Starts the opening when the shown tab's tree arrives for the first time, and again when the shown tab or its project changes. */
function trackMount(): void {
  const view = activeView();
  if (!view?.tree || loadOff) return;
  const key = `${active}|${view.project}`;
  if (key === mountKey) return;
  mountKey = key;
  mountAt = Date.now();
}

/** The opening progress (0 to 1) now; 1 is the normal map. An approval ends it at once. */
function mountProgress(): number {
  if (loadOff || activeView()?.state === "approval") return 1;
  if (loadFrozen !== null) return loadFrozen;
  return mountAt === null ? 1 : Math.min(1, (Date.now() - mountAt) / MOUNT_MS);
}
const mounting = (): boolean => mountProgress() < 1;

/**
 * Notes when each request arrived, and forgets the ones that went. A request is told apart by tab, id and text: a
 * server that restarted counts ids from 1 again, which shows as a lower id (everything is forgotten) or as another text.
 */
function trackArrivals(): void {
  const live = new Set<string>();
  for (const t of hub?.tabs ?? []) {
    const approval = t.view.approval;
    if (!approval) continue;
    if (approval.id < (highestId.get(t.id) ?? 0)) arrivals.clear();
    highestId.set(t.id, approval.id);
    const key = `${t.id}:${approval.id}`;
    live.add(key);
    if (arrivals.get(key)?.text !== approval.text) arrivals.set(key, { at: Date.now(), text: approval.text });
  }
  for (const key of [...arrivals.keys()]) if (!live.has(key)) arrivals.delete(key);
}
trackArrivals();
trackMount();

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

/** Whose request the page number is for ("tab:id"); a page never carries over to another request, whatever moved. */
let pageOwner = "";

function screenNow(): CodeScreen {
  const view = activeView();
  const owner = view?.state === "approval" && view.approval ? `${active}:${view.approval.id}` : "";
  if (owner !== pageOwner) {
    pageOwner = owner;
    setPage(0);
  }
  const s = screenFor(view);
  setPage(s.page);
  const icon = holding ? "recording" : s.icon;
  // A change of state or of icon shows at once, not at the next slow poll of a still picture.
  if (s.scene !== sceneNow || icon !== iconNow) pipe?.poke();
  sceneNow = s.scene;
  iconNow = icon;
  const now = mounting() && (s.scene === "live" || s.scene === "rest");
  if (wasMounting && !now) pipe?.poke();
  wasMounting = now;
  latest = { ...s, icon };
  return latest;
}

const cellsOf = (s: CodeScreen): Record<string, Cell> => ({
  [STATUS.name]: s.status,
  [PROMPT.name]: s.prompt,
  [STEPS.name]: s.steps,
  [STEP.name]: s.step,
  [CALL.name]: s.call,
  [FOLDER.name]: s.folder,
  [HINT.name]: s.hint,
  [BODY.name]: s.body,
});

const emptyView: CodeView = { state: "off", project: "", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };

function menu(): MenuContainerProperty {
  const items = (hub?.tabs ?? []).map(
    // No "waiting" mark: the tab squares of the header show it, and a menu that changes with every request would rebuild the page.
    (t, i) => new MenuItemProperty({ itemID: t.id, itemName: menuLabel(i, t.view.project, false) }),
  );
  if ((hub?.tabs.length ?? 0) < 6) items.push(new MenuItemProperty({ itemID: NEW_TAB, itemName: "+  New tab" }));
  if ((hub?.tabs.length ?? 0) > 1) items.push(new MenuItemProperty({ itemID: CLOSE_TAB, itemName: "×  Close this tab" }));
  return new MenuContainerProperty({ menuItems: items });
}

/** The one page: the four lens tiles behind, the eight text containers in front, the body taking the input. */
function layout(content: Record<string, Cell>): PageSpec {
  const cell = (box: Box): Cell => content[box.name] ?? { content: "", color: LIGHT.ambient };
  return {
    containerTotalNum: LENS_TILES.length + TEXT_BOXES.length,
    // Images behind, text in front: every container sets zOrderIndex, or a picture would hide the text over it.
    imageObject: LENS_TILES.map(
      (b, i) => new ImageContainerProperty({ xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name, zOrderIndex: i + 1 }),
    ),
    textObject: TEXT_BOXES.map((box, i) => textProp(box, cell(box), { zOrderIndex: 10 + i, ...(box === BODY ? { isEventCapture: 1 } : {}) })),
    menuObject: menu(),
  };
}

// ---- The picture ---------------------------------------------------------------

/** The screen for a view, as the pass draws it: the same function for the text and for the picture. */
function screenFor(view: CodeView | null): CodeScreen {
  const tabs = tabStates(hub, active);
  if (hub && !view && hub.error) return codeScreen({ ...emptyView, state: "off", error: hub.error }, 0, new Date(), tabs, "", 1);
  // A hub error (a CODE_DIRS folder that did not open) also shows when tabs exist, but never hides the tab's own error.
  const shownView = view && !view.error && hub?.error ? { ...view, error: hub.error } : view;
  return codeScreen(shownView, page, new Date(), tabs, notice(), mountProgress());
}

/** What the card in the picture is made of for a view: the request, its call and its tag and note. Empty when there is no request. */
const cardKey = (tab: number, view: CodeView | null): string =>
  view?.state === "approval" && view.approval
    ? `${tab}|${view.approval.id}|${view.approval.text}|${view.approval.tool ?? ""}|${view.approval.network === true}`
    : "";
/** The card key of the frame being drawn now; the tile that is rendered from it is stamped with it. */
let frameKey = "";

/** One frame of the whole lens at time `t`: the board's drawing, from one snapshot of the view. */
function lensFrame(t: number): Uint8Array {
  const canvas = lensCanvas();
  // A demo feeds the board's moment as input (when the task started, when the request arrived); everything shown is computed from it.
  const moment = demo ? demoMoment(demoScene, t) : null;
  const view = moment ? (moment.hub.tabs.find((x) => x.id === active)?.view ?? null) : activeView();
  const approval = view?.approval;
  const arrivedAt = moment ? moment.arrivedAt : approval ? arrivals.get(`${active}:${approval.id}`)?.at : undefined;
  level += (levelTarget - level) * 0.35;
  levelTarget *= 0.8;
  const input = liveInput(view, arrivedAt, moment ? moment.now : Date.now(), level);
  // The tag and the note come from this view, the same one the picture shows, not from the last pass.
  frameKey = cardKey(active, view);
  renderCodeLens(canvas, buildLens(screenFor(view), view, tabStates(hub, active), input), t, mountProgress());
  return canvas.pixels;
}

// ---- Which tiles the glasses accepted ---------------------------------------------

/** The card key of the frame each tile last rendered, and of the frame it last had accepted (a send that succeeded). */
const tileRendered = new Map<string, string>();
const tileAccepted = new Map<string, string>();
const tilePixels = new Map<string, Uint8Array>();

/** A tile frame was rendered: if it equals what the glasses already hold, it counts as accepted for its key. */
function noteTile(name: string, frame: Uint8Array): void {
  tileRendered.set(name, frameKey);
  const held = tilePixels.get(name);
  if (held && sameFrame(held, frame)) tileAccepted.set(name, frameKey);
}

/** The pipe's bridge: it passes every image send on and notes the ones the glasses accepted. */
function trackedBridge(real: EvenAppBridge): EvenAppBridge {
  return Object.create(real, {
    updateImageRawData: {
      value: async (update: ImageRawDataUpdate) => {
        const result = await real.updateImageRawData(update);
        if (result === ImageRawDataUpdateResult.success) {
          const name = update.containerName ?? "";
          tilePixels.set(name, Uint8Array.from(update.imageData as ArrayLike<number>));
          tileAccepted.set(name, tileRendered.get(name) ?? "");
        }
        return result;
      },
    },
  }) as EvenAppBridge;
}

/** The picture holds the card of the request now on show: every tile that shows it has been accepted by the glasses. */
function rasterAccepted(): boolean {
  const key = cardKey(active, activeView());
  return key !== "" && LENS_TILES.every((b) => tileAccepted.get(b.name) === key);
}

/** 4 frames a second while something moves (the icon, the steps and the map, the countdown), none for a still screen. */
const lensFps = (): number => (iconFps(latest.icon) > 0 || latest.scene === "live" || latest.scene === "approval" || mounting() ? 4 : 0);

const producers = (): Producer[] =>
  lensTiles(lensFrame, lensFps).map((p) => ({
    ...p,
    render: (t: number) => {
      const frame = p.render(t);
      noteTile(p.box.name, frame);
      return frame;
    },
  }));

// ---- Pages -------------------------------------------------------------------

/** The page is rebuilt only when the tab menu changes (the menu lists the tabs). A request does not change it. */
const keyOfMenu = () => (hub?.tabs ?? []).map((t) => `${t.id}:${t.view.project}`).join("|");

/** A bridge call that fails, throws or gives no answer in time is a call that did not reach the glasses. */
function capped(call: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), BRIDGE_TIMEOUT_MS);
  });
  return Promise.race([call.catch(() => false), timeout]).finally(() => clearTimeout(timer));
}

/** Remembers what a new page was built with, so only changes are sent. */
function remember(content: Record<string, Cell>): void {
  shown.clear();
  for (const [name, cell] of Object.entries(content)) shown.set(name, { content: fitBytes(cell.content), color: cell.color });
}

async function rebuildIfNeeded(): Promise<void> {
  const s = screenNow();
  const key = keyOfMenu();
  // After a system exit nothing more goes to the glasses.
  if (!bridge || stopped || key === pageKey || Date.now() < menuRetryAt) return;
  const content = cellsOf(s);
  // A new page starts its approval timing again: what was on the old page does not count.
  seen = null;
  generation++;
  tileAccepted.clear();
  tilePixels.clear();
  pipe?.set([]);
  // A rebuild never overlaps an image send.
  await pipe?.settled();
  if (stopped) return;
  const ok = await capped(bridge.rebuildPageContainer(new RebuildPageContainer(layout(content))));
  if (ok) {
    pageKey = key;
    remember(content);
  } else {
    // Not on the glasses: the old page may still be there, but it is not known to be this one.
    shown.clear();
    pageKey = "";
    menuRetryAt = Date.now() + MENU_RETRY_MS; // the 1 s tick tries again
  }
  pipe?.set(producers());
}

/** True when the cell is on the glasses: unchanged, or sent and confirmed. */
async function update(box: Box, cell: Cell): Promise<boolean> {
  const next = { content: fitBytes(cell.content), color: cell.color };
  const prev = shown.get(box.name);
  if (!bridge || stopped) return false;
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
      await rebuildIfNeeded();
      // What this pass draws, taken on one tick.
      const started = generation;
      const tab = active;
      const view = activeView();
      const s = screenNow();
      const next = cellsOf(s);
      // Every container is brought to this tick's text, the call text of an approval among them.
      let drawn = true;
      for (const box of TEXT_BOXES) if (!(await update(box, next[box.name] ?? { content: "", color: LIGHT.ambient }))) drawn = false;
      if (!drawn && bridge && keyOfMenu() !== pageKey && Date.now() >= menuRetryAt) renderAgain = true;
      // An approval counts as on the glasses only when its call text was accepted and the page is the one built for this menu.
      // Only if nothing that clears it happened meanwhile (a disconnect, a rebuild, a page change): the next pass redraws.
      if (generation === started) {
        // Another call under the same id (a restarted server) starts its 0.7 s again.
        const same = view?.approval?.text === seenText;
        seen = seenAfterRender(same ? seen : null, drawn && pageKey === keyOfMenu(), tab, view, s, Date.now());
        seenText = seen ? view?.approval?.text : undefined;
      }
      else renderAgain = true;
      // The app was closed during this pass: start no other.
    } while (renderAgain && !stopped);
  } finally {
    rendering = false;
  }
}

function selectTab(id: number): void {
  if (id === active || holding) return;
  active = id;
  setPage(0);
  trackMount();
  phone();
  scheduleRender();
}

/** A demo has no server: what the page sends goes nowhere. */
const noServer: Server = { send: () => {}, sendBinary: () => {}, isOpen: () => false, close: () => {} };
const server: Server = demo
  ? noServer
  : connectServer(
    (message) => {
      if (message.type === "error") {
        keyNote = message.message;
        phone();
        scheduleRender();
        return;
      }
      if (message.type !== "code") return;
      const before = activeView();
      const tabBefore = active;
      hub = message.data;
      if (!hub.tabs.some((t) => t.id === active)) active = hub.tabs[0]?.id ?? -1;
      const after = activeView();
      // Request ids count per tab: a page belongs to a tab and a request together.
      if (tabBefore !== active || before?.result !== after?.result || before?.approval?.id !== after?.approval?.id) setPage(0);
      if (busy(before) && after && !busy(after)) restSince = Date.now();
      trackArrivals();
      trackMount();
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
        generation++;
        // `arrivals` stays: a request that lived through the drop keeps counting from its first arrival, like the server's timer.
        cancelAllow();
        // The audio has nowhere to go. The server drops the hold and shows the note after the reconnect.
        dropHold("");
      }
      phone();
      scheduleRender();
    },
    "code",
);

if (demo) phone();

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
  if (demo) return;
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

/** The page built for the current tab menu is confirmed on the glasses, and so is the picture of the card on show. */
const approvalConfirmed = (): boolean => pageKey === keyOfMenu() && rasterAccepted();

/** A tap: allow the request on the glasses, after ALLOW_DELAY_MS and only if it is still there then. */
function tapAllow(): void {
  if (pendingAllow || !approvalConfirmed() || !seen || !canAllow(seen, active, activeView(), page, Date.now(), seenText)) return;
  const { tab, id } = seen;
  pendingAllow = {
    tab,
    id,
    timer: setTimeout(() => {
      pendingAllow = null;
      if (!approvalConfirmed() || seen?.tab !== tab || seen.id !== id || !canAllow(seen, active, activeView(), page, Date.now(), seenText)) return;
      server.send({ type: "code_decide", tab, id, allow: true });
    }, ALLOW_DELAY_MS),
  };
}

function onEvent(event: EvenHubEvent): void {
  if (event.audioEvent) {
    if (!holding) return;
    const { audioPcm, speakerRole } = event.audioEvent;
    levelTarget = Math.max(levelTarget, voiceLevel(audioPcm));
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
      // Only a request that is still the one pending is denied; a resolved one must not swallow a stop.
      const live = (ref: ApprovalRef | null): ApprovalRef | null =>
        ref && ref.tab === active && view?.state === "approval" && view.approval?.id === ref.id ? ref : null;
      // A request on show whose text is not accepted yet is denied too: a deny is always safe.
      const pending = view?.state === "approval" && view.approval ? { tab: active, id: view.approval.id } : null;
      const action = doubleTapAction(live(cancelAllow()) ?? live(seen) ?? pending, active, view, restSince, Date.now());
      if (action) server.send(action);
      break;
    }
    case OsEventTypeList.SCROLL_TOP_EVENT:
      setPage(Math.max(0, page - 1));
      scheduleRender();
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      setPage(Math.min(page + 1, Math.max(0, latest.pageCount - 1)));
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
/** The exit watch, set right after the bridge arrives. */
let stopExit: (() => void) | null = null;

/** The host is closing the app. The WebView can outlive this event, so release everything here (as Answers does). */
function shutdown(): void {
  if (stopped) return;
  cancelAllow();
  // Sends the discard and closes the microphone before the socket closes.
  dropHold("");
  stopped = true;
  stopExit?.();
  stopPage?.();
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  server.close();
}

async function start(): Promise<void> {
  const host = await waitForEvenAppBridge();
  // At once, so an exit during the intro or the page build is not lost. shutdown() is safe to call twice.
  stopExit = onExit(host, shutdown);
  const intro = await playSplash(host, { name: "Code", icon: ICON, order: ORDER });
  if (intro.exited || stopped) return shutdown();
  // The first page is built after the intro, so what arrived during it is on it.
  const s = screenNow();
  const content = cellsOf(s);
  // On failure, carry on: after a reload the host still holds the old page. `shown` stays empty, so every cell is
  // sent again, and `pageKey` stays empty, so the page is rebuilt.
  if (await openPage(host, layout(content), intro.startedUp)) {
    pageKey = keyOfMenu();
    remember(content);
  } else notePageFailure();
  if (stopped) return;
  // Only now: text updates, page rebuilds and the microphone need the page.
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  pipe = new ImagePipe(trackedBridge(bridge));
  pipe.set(pageKey ? producers() : []);
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
