import {
  ImageContainerProperty,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { SAMPLE_OSINT } from "../around/sample";
import type { Box } from "../core/box";
import { eventTypeOf } from "../core/events";
import { ImagePipe } from "../core/imagepipe";
import { connectServer, type Server } from "../core/net";
import { notePageFailure, openPage } from "../core/page";
import type { Osint } from "../core/protocol";
import { clockText, fitBytes } from "../core/text";
import { tiled } from "../core/tiles";
import { drawable, feedNotice, type Link } from "../around/render";
import { RH, RW, planesInRange, renderSky, skyFps, skyLines } from "./render";

/** Sky: what your Pi's ADS-B receiver hears, on a radar. */

const TILES: Box[] = [
  { id: 1, name: "top", x: 0, y: 0, width: 288, height: 144 },
  { id: 2, name: "bottom", x: 0, y: 144, width: 288, height: 144 },
];
const STATUS: Box = { id: 3, name: "status", x: 300, y: 4, width: 220, height: 30 };
const CLOCK: Box = { id: 4, name: "clock", x: 528, y: 4, width: 48, height: 30 };
const LIST: Box = { id: 5, name: "list", x: 300, y: 40, width: 276, height: 246 };
const LIST_LINES = 8;

const demo = new URLSearchParams(location.search).has("demo");
let osint: Osint | null = demo ? SAMPLE_OSINT : null;
let page = 0;
let bridge: EvenAppBridge | null = null;
let pipe: ImagePipe | null = null;
const shown = new Map<string, string>();
let link: Link = "connecting";
/** An "error" message from the connection, such as a missing pairing key; cleared when a socket opens. */
let serverError: string | null = null;
const statusEl = document.getElementById("status");
let server: Server | null = null;
/** Stops the image pipe and the timer and drops the event subscription; set once the page exists. */
let stopPage: (() => void) | null = null;

const notice = (): string | null => (demo ? null : feedNotice(osint, link, serverError, Date.now() / 1000));
/** Live: aircraft are drawn and the sweep turns only in this state. */
const live = (): boolean => demo || (link === "open" && osint?.connected === true && notice() === null);
let wasLive = live();

function texts(): [Box, string, number][] {
  const problem = notice();
  if (problem) {
    return [
      [STATUS, "SKY", 2],
      [CLOCK, clockText(new Date()), 1],
      [LIST, problem, 2],
    ];
  }
  const lines = skyLines(osint);
  const pages = Math.max(1, Math.ceil(lines.length / LIST_LINES));
  page = Math.min(page, pages - 1);
  const count = planesInRange(osint).length;
  const pager = pages > 1 ? `  ·  ${page + 1}/${pages}` : "";
  return [
    // No count while Loops is away: the server has no current aircraft then.
    [STATUS, osint?.connected ? `SKY  ·  ${count} aircraft${pager}` : `SKY${pager}`, 2],
    [CLOCK, clockText(new Date()), 1],
    [LIST, lines.slice(page * LIST_LINES, page * LIST_LINES + LIST_LINES).join("\n"), osint?.connected ? 4 : 2],
  ];
}

async function renderText(): Promise<void> {
  if (statusEl) statusEl.textContent = notice() ?? (link === "open" || demo ? "Connected." : "Connecting…");
  if (!bridge) return;
  for (const [box, content, color] of texts()) {
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
  stopPage?.();
  stopPage = null;
  server?.close();
  server = null;
}

function onEvent(event: EvenHubEvent): void {
  const type = eventTypeOf(event);
  // Foreground enter and exit also fire when a menu opens and closes: they change nothing.
  if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) return shutdown();
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) page++;
  else if (type === OsEventTypeList.SCROLL_TOP_EVENT) page = Math.max(0, page - 1);
  void renderText();
}

async function start(): Promise<void> {
  if (!demo) {
    server = connectServer(
      (message) => {
        if (message.type === "osint") osint = message.data;
        else if (message.type === "error") serverError = message.message;
        else return;
        refresh();
      },
      (connected) => {
        link = connected ? "open" : "closed";
        if (connected) serverError = null;
        refresh();
      },
    );
  }
  // `bridge` is set only once the page exists, so no text update goes to a page that is not there yet.
  const host = await waitForEvenAppBridge();
  const initial = texts();
  const ok = await openPage(host, {
    containerTotalNum: 5,
    imageObject: TILES.map(
      (b) => new ImageContainerProperty({ xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name }),
    ),
    textObject: initial.map(
      ([b, content, color]) =>
        new TextContainerProperty({
          xPosition: b.x, yPosition: b.y, width: b.width, height: b.height, containerID: b.id, containerName: b.name,
          content: fitBytes(content), textColor: color, paddingLength: 0, isEventCapture: b === LIST ? 1 : 0,
        }),
    ),
  });
  // On failure, carry on: after a reload the host still holds the old page (with unknown text).
  if (ok) for (const [b, content, color] of initial) shown.set(b.name, `${color}|${content}`);
  else notePageFailure();
  bridge = host;
  const unsubscribe = bridge.onEvenHubEvent(onEvent);
  const images = new ImagePipe(bridge);
  pipe = images;
  // The sweep turns at 1 frame a second, only while live aircraft are in range; else the
  // radar is still and costs nothing. Only changed tiles are sent.
  const view = () => drawable(osint, live());
  images.set(tiled(TILES, { width: RW, height: RH }, (t) => renderSky(view(), t), () => skyFps(view())));
  void images.run();
  // Data that arrived while the page was being created.
  void renderText();
  const tick = setInterval(() => {
    // A feed that went stale stops the sweep and hides the aircraft.
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
