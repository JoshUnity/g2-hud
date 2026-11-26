import {
  ImageContainerProperty,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import type { Box } from "../core/box";
import { eventTypeOf, onExit } from "../core/events";
import { startLocation, type LocationReporter } from "../core/location";
import { ImagePipe } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import type { LocalMap, Osint } from "../core/protocol";
import { LENS_TILES, STATUS_AT, lensTiles } from "../core/board";
import { LIGHT } from "../core/hud";
import { playSplash } from "../core/splash";
import { LINE, fitBytes, fitPx } from "../core/text";
import { demoScene } from "./demo";
import { ICON, ORDER } from "./icon";
import { ROWS_PER_PAGE, ROW_X, ROW_Y, aroundStatus, drawable, feedNotice, incidentRows, messageLines, pageCount, easeLoad, renderAround, type Link, type Row } from "./render";

/** Around: your city view as a full-screen live map. */

const TILES = LENS_TILES;
/** Text: the status where the header puts it, then the two incident titles. The clock is in the raster. */
const STATUS: Box = { id: 5, name: "status", x: STATUS_AT.x, y: STATUS_AT.y, width: 480, height: LINE };
const ROW1: Box = { id: 6, name: "row1", x: ROW_X, y: ROW_Y[0], width: 440, height: LINE };
const ROW2: Box = { id: 8, name: "row2", x: ROW_X, y: ROW_Y[1], width: 440, height: LINE };

const demoParam = new URLSearchParams(location.search).get("demo");
const scene = demoParam === null ? null : demoScene(demoParam);
let osint: Osint | null = scene?.osint ?? null;
let map: LocalMap | null = scene?.map ?? null;
let page = 0;
let bridge: EvenAppBridge | null = null;
let pipe: ImagePipe | null = null;
const shown = new Map<string, string>();
let link: Link = scene?.link ?? "connecting";
/** An "error" message from the connection, such as a missing pairing key; cleared when a socket opens. */
let serverError: string | null = null;
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

const notice = (): string | null => feedNotice(osint, link, serverError, scene?.frozen && osint ? osint.at : Date.now() / 1000);
/** Live: incidents, aircraft and vehicles are drawn and animated only in this state. */
const live = (): boolean => link === "open" && osint?.connected === true && notice() === null;
let wasLive = live();

/** The depth load: the map scans in from your feet to the horizon, once each time it first appears. */
const LOAD_MS = 2400;
/** Four containers move together, so the load takes 2 steps a second (DESIGN.md, motion budget). */
const LOAD_FPS = 2;
const loadParam = new URLSearchParams(location.search).get("load");
const loadOff = loadParam === "off";
const loadFrozen = loadParam !== null && !loadOff && Number.isFinite(Number(loadParam)) ? easeLoad(Number(loadParam)) : null;
let loadAt: number | null = null;
let hadPicture = false;

/** The load progress for this moment, eased: 1 when there is no load. Starts it when a map has just appeared. */
function reveal(): number {
  const has = live() && map !== null && osint?.me != null;
  if (has && !hadPicture && !loadOff) loadAt = performance.now();
  if (!has) loadAt = null;
  hadPicture = has;
  if (!has || loadOff) return 1;
  if (loadFrozen !== null) return loadFrozen;
  return loadAt === null ? 1 : easeLoad((performance.now() - loadAt) / LOAD_MS);
}

/** The rows to show: the incidents ranked from the feed (the demo feeds the same function). */
const rowsNow = (): Row[] => incidentRows(osint);

/** The three text containers that change: [box, content, brightness]. */
function texts(): [Box, string, number][] {
  const problem = notice();
  if (problem) return [[STATUS, "Around", LIGHT.near], [ROW1, fitPx(problem, ROW1.width), LIGHT.near], [ROW2, "", LIGHT.near]];
  const rows = rowsNow();
  page = Math.min(page, pageCount(rows.length) - 1);
  const shownRows = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE).map((r) => r.title);
  const lines = rows.length > 0 ? shownRows : messageLines(osint);
  const level = rows.length > 0 ? LIGHT.primary : LIGHT.near;
  return [
    [STATUS, aroundStatus(osint), LIGHT.near],
    [ROW1, fitPx(lines[0] ?? "", ROW1.width), level],
    [ROW2, fitPx(lines[1] ?? "", ROW2.width), Math.min(level, LIGHT.near)],
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

/** Redraws after a change of data or connection state. */
function refresh(): void {
  wasLive = live();
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
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) page++;
  else if (type === OsEventTypeList.SCROLL_TOP_EVENT) page = Math.max(0, page - 1);
  else if (type === OsEventTypeList.CLICK_EVENT) page = 0;
  else return;
  // The text clamps the page; the picture follows it.
  void renderText();
  pipe?.poke();
}

async function start(): Promise<void> {
  if (!scene) {
    server = connectServer(
      (message) => {
        if (message.type === "osint") osint = message.data;
        else if (message.type === "osint_map") map = message.data;
        else if (message.type === "error") serverError = message.message;
        else return;
        refresh();
      },
      (connected) => {
        link = connected ? "open" : "closed";
        if (connected) serverError = null;
        refresh();
        if (connected) locator?.resend();
      },
      "around",
    );
  }
  // `bridge` is set only once the page exists, so no text update goes to a page that is not there yet.
  const host = await waitForEvenAppBridge();
  // Listens from now on, so an exit during the intro or while the page is built is not lost.
  offExit = onExit(host, shutdown);
  if (stopped) return;
  if (!scene && server) locator = startLocation(host, server);
  // The intro owns the lens first. Nothing else sends to the glasses until it returns.
  const intro = await playSplash(host, { name: "Around", icon: ICON, order: ORDER });
  if (intro.exited || stopped) return shutdown();
  // After the intro, so data that arrived during it is on the first page.
  const initial = texts();
  // Images behind, text in front: every container sets zOrderIndex.
  const ok = await openPage(host, {
    containerTotalNum: 7,
    imageObject: TILES.map(
      (b, i) =>
        new ImageContainerProperty({ xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name, zOrderIndex: i + 1 }),
    ),
    textObject: initial.map(
      ([b, content, color], i) =>
        new TextContainerProperty({
          xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name,
          content: fitBytes(content), textColor: color, paddingLength: 0, isEventCapture: b === ROW1 ? 1 : 0, zOrderIndex: 10 + i,
        }),
    ),
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
  const view = () => drawable(osint, live());
  images.set(
    lensTiles(
      (t) => renderAround(map, view(), t, page, live(), reveal(), { clock: scene?.clock }),
      () => (reveal() < 1 && loadFrozen === null ? LOAD_FPS : view()?.items.some((i) => i.severity >= 3) ? 4 : 0),
    ),
  );
  void images.run();
  // Data that arrived while the page was being created.
  void renderText();
  const tick = setInterval(() => {
    // A feed that went stale stops its moving layers.
    if (live() !== wasLive) refresh();
    else void renderText();
  }, 15_000);
  stopPage = () => {
    unsubscribe();
    images.stop();
    clearInterval(tick);
  };
}

void start();
