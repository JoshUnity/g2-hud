import {
  ImageContainerProperty,
  OsEventTypeList,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import type { Box } from "../core/box";
import { LENS_TILES, lensCanvas, lensTiles } from "../core/board";
import { eventTypeOf, onExit } from "../core/events";
import { startLocation, type LocationReporter } from "../core/location";
import { textProp } from "../core/hud";
import { ImagePipe } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import type { Osint } from "../core/protocol";
import { playSplash } from "../core/splash";
import { LINE, clockText, fitBytes } from "../core/text";
import { drawable, feedNotice, type Link } from "../around/render";
import { demoScene } from "./demo";
import { ICON, ORDER } from "./icon";
import { LADDER_END, LIST_AT, LIST_ROWS, OPEN_MS, ROW_H, STATUS_AT, listText, renderSkyLens, skyMessage, skyPlanes, stepSelection, type SkyModel, type SkyPlane } from "./render";

/** Sky: the airspace your Pi's ADS-B receiver hears, as a volume, with an instrument panel. The whole lens is one raster. */

const STATUS: Box = { id: 5, name: "status", x: STATUS_AT.x, y: STATUS_AT.y, width: 182, height: LINE };
const LIST: Box = { id: 6, name: "list", x: LIST_AT.x, y: LIST_AT.y, width: LIST_AT.width, height: LIST_ROWS * ROW_H };

const scene = demoScene(location.search);
let osint: Osint | null = scene ? scene.osint : null;
/** The aircraft you picked, or null for the nearest. */
let selectedId: string | null = null;
let bridge: EvenAppBridge | null = null;
let pipe: ImagePipe | null = null;
const shown = new Map<string, string>();
let link: Link = scene ? scene.link : "connecting";
/** An "error" message from the connection, such as a missing pairing key; cleared when a socket opens. */
let serverError: string | null = scene ? scene.serverError : null;
const statusEl = document.getElementById("status");
let server: Server | null = null;
/** Stops the image pipe and the timer and drops the event subscription; set once the page exists. */
let stopPage: (() => void) | null = null;
/** The host closed the app: set by shutdown(), which may run before the page exists. */
let stopped = false;
/** Unsubscribes the early exit listener (see onExit). */
let offExit: (() => void) | null = null;
/** Sends the phone position to the server (live mode only). */
let locator: LocationReporter | null = null;

const nowS = (): number => scene?.nowS ?? Date.now() / 1000;
const notice = (): string | null => feedNotice(osint, link, serverError, nowS());
/** Live: aircraft are drawn and the sweep turns only in this state. */
const live = (): boolean => link === "open" && osint?.connected === true && notice() === null;
let wasLive = live();
/** What is drawn: no aircraft unless the feed is live. */
const view = (): Osint | null => drawable(osint, live());

/**
 * The opening: the radar acquires (rings, ladder, one sweep) each time live data first
 * shows, and again when the feed returns to live. `?load=<0..1>` freezes it at that
 * progress, `?load=off` skips it. Time-based, so a slow link shows fewer steps, not a longer opening.
 */
/** Four containers move together, so the opening takes 2 steps a second (DESIGN.md, motion budget). */
const OPEN_FPS = 2;
/** The sweep moves in the left tiles, one or two at a time: 4 frames a second. */
const SWEEP_FPS = 4;
const loadParam = new URLSearchParams(location.search).get("load");
const loadOff = loadParam === "off";
const loadFrozen = loadParam !== null && !loadOff && Number.isFinite(Number(loadParam)) ? Math.min(1, Math.max(0, Number(loadParam))) : null;
let openAt: number | null = null;
let wasShowing = false;

/** The opening progress right now, from 0 to 1; 1 means the normal picture. Starts it when the feed has just gone live. */
function opening(): number {
  const showing = live();
  if (showing && !wasShowing && !loadOff) openAt = performance.now();
  if (!showing) openAt = null;
  wasShowing = showing;
  if (!showing || loadOff) return 1;
  // An emergency never waits for the opening, and one that appears ends a running opening.
  if (modelPlanes().some((p) => p.emergency)) {
    openAt = null;
    return 1;
  }
  if (loadFrozen !== null) return loadFrozen;
  if (openAt === null) return 1;
  const r = (performance.now() - openAt) / OPEN_MS;
  return r >= 1 || (r >= LADDER_END && modelPlanes().length === 0) ? 1 : r;
}

/** An aircraft that left range drops the selection, so the nearest shows and a return does not jump back. */
function keepSelection(): void {
  if (selectedId !== null && !modelPlanes().some((p) => p.id === selectedId)) selectedId = null;
}

/** The aircraft in range, only while the feed is live. */
function modelPlanes(): SkyPlane[] {
  if (!live()) return [];
  return skyPlanes(osint);
}

/** The feed has just connected and has not answered with aircraft yet: that is loading, not a failure. */
const LOOKING_MS = 20_000;
let connectedAt: number | null = null;
const looking = (): boolean => !scene && connectedAt !== null && performance.now() - connectedAt < LOOKING_MS;

/** What the screen shows right now. */
function skyModel(): SkyModel {
  const problem = notice();
  const planes = modelPlanes();
  const v = view();
  const known = problem === null && v?.connected === true;
  return {
    planes,
    selectedId,
    showCount: known,
    message: skyMessage(v, problem, planes.length, looking()),
    noPosition: known && !v?.me,
    clock: clockText(scene?.now ?? new Date()),
    open: opening(),
    sweeping: known && planes.length > 0,
    source: v?.aircraftSource ?? null,
  };
}

function texts(): [Box, string, number][] {
  const m = skyModel();
  return [
    [STATUS, "Sky", STATUS_AT.level],
    [LIST, listText(m), LIST_AT.level],
  ];
}

async function renderText(): Promise<void> {
  if (statusEl) statusEl.textContent = notice() ?? (link === "open" ? "Connected." : "Connecting…");
  if (!bridge) return;
  for (const [box, content, color] of texts()) {
    // A system exit clears `bridge` while an earlier box is in flight: send nothing more.
    if (!bridge) return;
    const key = `${color}|${content}`;
    if (shown.get(box.name) === key) continue;
    // Marked before the send, so overlapping renders do not send it twice.
    shown.set(box.name, key);
    let ok = false;
    try {
      ok = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: fitBytes(content), textColor: color }),
      );
    } finally {
      // Not on the glasses: forget it, so the next render or the 15 s timer sends it again.
      if (!ok && shown.get(box.name) === key) shown.delete(box.name);
    }
  }
}

/** Redraws after a change of data, connection state or selection. */
function refresh(): void {
  wasLive = live();
  opening();
  keepSelection();
  pipe?.poke();
  void renderText();
}

/** The app is closing. The WebView can outlive this event, so release everything here. */
function shutdown(): void {
  // Safe to call twice, and before the page exists.
  if (stopped) return;
  stopped = true;
  // After this, nothing is sent to the glasses.
  bridge = null;
  offExit?.();
  offExit = null;
  stopPage?.();
  stopPage = null;
  locator?.stop();
  locator = null;
  server?.close();
  server = null;
}

function onEvent(event: EvenHubEvent): void {
  const type = eventTypeOf(event);
  // The host stops location updates while the app is suspended: start them again on return.
  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) return locator?.rearm();
  // Foreground exit also fires when a menu opens and closes: it changes nothing.
  if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) return shutdown();
  // Swipe down: the next aircraft out. Swipe up: the next one in. Tap: back to the nearest.
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) selectedId = stepSelection(modelPlanes(), selectedId, 1);
  else if (type === OsEventTypeList.SCROLL_TOP_EVENT) selectedId = stepSelection(modelPlanes(), selectedId, -1);
  else if (type === OsEventTypeList.CLICK_EVENT) selectedId = null;
  else return;
  refresh();
}

async function start(): Promise<void> {
  if (!scene) {
    server = connectServer(
      (message) => {
        if (message.type === "osint") {
          osint = message.data;
          connectedAt ??= performance.now();
        } else if (message.type === "error") serverError = message.message;
        else return;
        refresh();
      },
      (connected) => {
        link = connected ? "open" : "closed";
        if (!connected) connectedAt = null;
        if (connected) serverError = null;
        refresh();
        if (connected) locator?.resend();
      },
      "sky",
    );
  }
  // `bridge` is set only once the page exists, so no text update goes to a page that is not there yet.
  const host = await waitForEvenAppBridge();
  // Listens from now on, so an exit during the intro or while the page is built is not lost.
  offExit = onExit(host, shutdown);
  if (stopped) return;
  if (!scene && server) locator = startLocation(host, server);
  // The intro owns the lens first. Nothing else sends to the glasses until it returns.
  const intro = await playSplash(host, { name: "Sky", icon: ICON, order: ORDER });
  if (intro.exited || stopped) return shutdown();
  // After the intro, so data that arrived during it is on the first page.
  const initial = texts();
  const ok = await openPage(host, {
    containerTotalNum: LENS_TILES.length + initial.length,
    // Images behind, text in front: every container sets zOrderIndex.
    imageObject: LENS_TILES.map(
      (b, i) => new ImageContainerProperty({ xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name, zOrderIndex: i + 1 }),
    ),
    textObject: initial.map(([b, content, color], i) => textProp(b, { content, color }, { isEventCapture: b === LIST ? 1 : 0, zOrderIndex: 10 + i })),
  }, intro.startedUp);
  // On failure, carry on: after a reload the host still holds the old page (with unknown text).
  if (ok) for (const [b, content, color] of initial) shown.set(b.name, `${color}|${content}`);
  else notePageFailure();
  // The host closed the app while the page was being built: the page is not used.
  if (stopped) return;
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  const images = new ImagePipe(bridge);
  pipe = images;
  // One raster in four tiles; only changed tiles are sent. The sweep and the opening spread over the two left
  // tiles, so they ask for 2 frames a second (DESIGN.md, motion budget), the sweep for 4; a still picture asks for none.
  const animating = (): boolean => loadFrozen === null && opening() < 1;
  images.set(
    lensTiles(
      (t) => {
        const canvas = lensCanvas();
        // Frozen at a load progress, the picture must not move with the clock.
        renderSkyLens(canvas, skyModel(), loadFrozen === null ? t : 0);
        return canvas.pixels;
      },
      () => (animating() ? OPEN_FPS : skyModel().sweeping ? SWEEP_FPS : 0),
    ),
  );
  void images.run();
  // Data that arrived while the page was being created.
  void renderText();
  // Every 250 ms: while it opens, the list rows appear as the sweep finds their aircraft.
  // Every 60th beat (15 s): the usual check for a feed that went stale.
  let wasOpening = false;
  let wasLooking = false;
  let beat = 0;
  const tick = setInterval(() => {
    const now = loadFrozen === null && opening() < 1;
    const slow = ++beat % 60 === 0;
    if (slow && live() !== wasLive) refresh();
    else if (now || wasOpening || slow || looking() || wasLooking) void renderText();
    wasOpening = now;
    wasLooking = looking();
  }, 250);
  stopPage = () => {
    unsubscribe();
    images.stop();
    clearInterval(tick);
  };
}

void start();
