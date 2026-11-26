import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { Box } from "./box";
import { eventTypeOf } from "./events";
import { LIGHT } from "./hud";
import { ICON_CELLS, type IconGrid } from "./icon";
import { ImagePipe } from "./imagepipe";
import { Canvas, lv } from "./pixels";
import { LINE, textWidth } from "./text";

/**
 * The launch intro, shared by all five apps. The app's icon draws itself on in
 * the centre of the lens as a dot-matrix logo, its name types in below in real
 * glasses text, the mark pulses once, then both go dark and the app builds its
 * own page.
 */

export const SPLASH_MS = 1600;
/** The one image container of the splash page: the 96 x 96 mark, centred on the 576 x 288 lens. */
export const SPLASH_MARK: Box = { id: 1, name: "splash", x: 240, y: 70, width: 96, height: 96 };
/** The name sits under the mark. Its x depends on the name: see `nameBox`. */
export const SPLASH_NAME_Y = 184;

const DRAW_END = 900;
const PULSE_END = 1250;
const NAME_START = 500;
const NAME_END = 1000;
const OUT_START = 1300;
/** Each icon cell is a 6 x 6 square on an 8 px pitch. */
const DOT = 6;
const PITCH = 8;
/** A cell is "hot" (full light) for this share of `draw` after it appears. */
const HOT_SPAN = 0.07;
const HOT = 255;
const SETTLED = lv(0.72);
const FPS = 8;
/** How often the name is checked for a change. */
const NAME_POLL_MS = 40;
/** The create call may take this long before the splash counts as "not created". */
const CREATE_TIMEOUT_MS = 3000;
/** How long past SPLASH_MS the whole splash may take, even if image sends hang. */
const CAP_SLACK_MS = 1500;
const NAME_BOX_ID = 2;
const NAME_BOX_NAME = "splash-name";
/** Spare width after the name, so the firmware never wraps it. */
const NAME_SLACK = 16;

/** ms: since the splash started. t: the same in seconds (for continuous motion such as rotation).
 *  draw: 0 -> 1 over 0-900 ms, ease-out cubic. pulse: 0 before 900 ms, then 1 -> 0 over 900-1250 ms. */
export type SplashFrame = { ms: number; t: number; draw: number; pulse: number };
/** name: the app's name in mixed case. icon: its 12 x 12 grid. order: when, from 0 to 1, a cell lights up. */
export type SplashSpec = { name: string; icon: IconGrid; order: (row: number, col: number) => number };
export type SplashResult = { startedUp: boolean; exited: boolean };

export function splashFrame(ms: number): SplashFrame {
  const p = Math.min(1, Math.max(0, ms / DRAW_END));
  const pulse = ms < DRAW_END ? 0 : Math.max(0, 1 - (ms - DRAW_END) / (PULSE_END - DRAW_END));
  return { ms, t: ms / 1000, draw: 1 - (1 - p) ** 3, pulse };
}

/**
 * One 96 x 96 frame of the dot-matrix mark. Pure. Cells appear in `order`; a new
 * cell and the pulse are at full light, the rest a step back. In the out phase
 * cells go dark one by one in a fixed scattered order.
 */
export function renderSplash(spec: SplashSpec, ms: number): Uint8Array {
  const canvas = new Canvas(SPLASH_MARK.width, SPLASH_MARK.height);
  if (ms >= SPLASH_MS) return canvas.pixels;
  const { draw, pulse } = splashFrame(ms);
  const gone = Math.max(0, (ms - OUT_START) / (SPLASH_MS - OUT_START));
  for (let row = 0; row < ICON_CELLS; row++) {
    for (let col = 0; col < ICON_CELLS; col++) {
      if (spec.icon[row]?.[col] !== "#") continue;
      const when = spec.order(row, col);
      if (when > draw) continue;
      if (((row * 7 + col * 13) % 17) / 17 < gone) continue;
      const hot = pulse > 0 || (draw < 1 && draw - when < HOT_SPAN);
      canvas.rect(col * PITCH, row * PITCH, DOT, DOT, hot ? HOT : SETTLED);
    }
  }
  return canvas.pixels;
}

/** The name text at this moment: it types in from 500 to 1000 ms, then steps back in light as it goes out. */
export function splashName(spec: SplashSpec, ms: number): { content: string; color: number } {
  const letters = [...spec.name];
  if (ms >= SPLASH_MS) return { content: "", color: LIGHT.ambient };
  if (ms < NAME_START) return { content: "", color: LIGHT.primary };
  const shown = Math.min(letters.length, Math.ceil(((ms - NAME_START) / (NAME_END - NAME_START)) * letters.length));
  const content = letters.slice(0, shown).join("");
  if (ms <= OUT_START) return { content, color: LIGHT.primary };
  const third = ((ms - OUT_START) / (SPLASH_MS - OUT_START)) * 3;
  return { content, color: third < 1 ? LIGHT.near : third < 2 ? LIGHT.secondary : LIGHT.ambient };
}

/** The name's box: centred by its pixel width, left-aligned, so letters type in at their final places. */
export function nameBox(name: string): Box {
  const width = textWidth(name);
  return { id: NAME_BOX_ID, name: NAME_BOX_NAME, x: Math.round((576 - width) / 2), y: SPLASH_NAME_Y, width: width + NAME_SLACK, height: LINE };
}

/** `?intro=0` skips the splash. `?intro=<ms>` (a positive number) freezes it at that time, for screenshots. */
export function introParam(search: string = typeof location === "undefined" ? "" : location.search): { skip: boolean; freezeMs: number | null } {
  const value = new URLSearchParams(search).get("intro");
  if (value === null || value.trim() === "") return { skip: false, freezeMs: null };
  const n = Number(value);
  if (n === 0) return { skip: true, freezeMs: null };
  return { skip: false, freezeMs: Number.isFinite(n) && n > 0 ? n : null };
}

/** A timer that can be cancelled, so a finished splash leaves nothing pending. */
function timer(ms: number): { done: Promise<void>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
}

/**
 * Plays the splash on the start-up page and leaves that page on the lens (the
 * app's openPage then replaces it, with startedUp = true). It never blocks the
 * app for long: the create call has a 3 s cap, and once the page exists the
 * whole splash ends by SPLASH_MS + 1500 ms even if image sends hang. In that
 * case the pipe is stopped and a hung send is left behind, not awaited.
 */
export async function playSplash(bridge: EvenAppBridge, spec: SplashSpec): Promise<SplashResult> {
  const { skip, freezeMs } = introParam();
  if (skip) return { startedUp: false, exited: false };
  const none: SplashResult = { startedUp: false, exited: false };
  const label = nameBox(spec.name);

  const createWait = timer(CREATE_TIMEOUT_MS);
  let created: StartUpPageCreateResult | "timeout";
  try {
    created = await Promise.race([
      bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 2,
          imageObject: [
            new ImageContainerProperty({
              xPosition: SPLASH_MARK.x, yPosition: SPLASH_MARK.y, width: SPLASH_MARK.width, height: SPLASH_MARK.height,
              containerID: SPLASH_MARK.id, containerName: SPLASH_MARK.name,
            }),
          ],
          // The name's container also takes the input, so an exit event reaches the splash.
          textObject: [
            new TextContainerProperty({
              xPosition: label.x, yPosition: label.y, width: label.width, height: label.height,
              containerID: label.id, containerName: label.name, content: "", textColor: LIGHT.primary, paddingLength: 0, isEventCapture: 1,
            }),
          ],
        }),
      ),
      createWait.done.then(() => "timeout" as const),
    ]);
  } catch {
    return none;
  } finally {
    createWait.cancel();
  }
  // Refused: the WebView reloaded, or the host is not there. A reload must not replay the intro.
  if (created !== StartUpPageCreateResult.success) return none;

  const began = performance.now();
  const now = (): number => freezeMs ?? performance.now() - began;
  let blackRendered!: () => void;
  const black = new Promise<void>((resolve) => (blackRendered = resolve));
  let exitNow!: () => void;
  const exit = new Promise<"exit">((resolve) => (exitNow = () => resolve("exit")));
  const unsubscribe = bridge.onEvenHubEvent((event) => {
    const type = eventTypeOf(event);
    if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) exitNow();
  });

  const pipe = new ImagePipe(bridge);
  pipe.set([
    {
      box: SPLASH_MARK,
      fps: () => FPS,
      // The animation follows the clock, not the frame count: a slow link shows fewer frames, never a longer intro.
      render: () => {
        const ms = now();
        if (freezeMs === null && ms >= SPLASH_MS) blackRendered();
        return renderSplash(spec, ms);
      },
    },
  ]);
  const loop = pipe.run().then(undefined, () => undefined);

  // The name follows the clock too. It sends one upgrade at a time, and only when the text or its light changed.
  // "run": follow the clock. "finish": clear the name once, then end. "abort": end at once; nothing more is sent.
  let phase: "run" | "finish" | "abort" = "run";
  const naps = new Set<() => void>();
  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(handle);
        naps.delete(wake);
        resolve();
      };
      const handle = setTimeout(wake, ms);
      naps.add(wake);
    });
  const setPhase = (next: "finish" | "abort"): void => {
    phase = next;
    for (const wake of [...naps]) wake();
  };
  const names = async (): Promise<void> => {
    let sent = "4|";
    while (phase !== "abort") {
      const want = splashName(spec, now());
      const content = phase === "finish" ? "" : want.content;
      const key = `${want.color}|${content}`;
      if (key === sent) {
        if (phase === "finish") return;
        await nap(freezeMs === null ? NAME_POLL_MS : 250);
        continue;
      }
      // One try in "finish", made after the last "run" send has ended: the page is about to be replaced anyway.
      const closing = phase === "finish";
      let ok = false;
      try {
        ok = await bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: label.id, containerName: label.name, content, textColor: want.color }),
        );
      } catch {
        ok = false;
      }
      if (ok) sent = key;
      if (closing) return;
      if (!ok) await nap(NAME_POLL_MS);
    }
  };
  const nameLoop = names().then(undefined, () => undefined);

  const cap = freezeMs === null ? timer(SPLASH_MS + CAP_SLACK_MS) : null;
  let exited = false;
  try {
    // A frozen splash stays until the app exits.
    const ended = await Promise.race([freezeMs === null ? black.then(() => "black" as const) : exit, exit, cap?.done ?? exit]);
    exited = ended === "exit";
  } finally {
    unsubscribe();
    pipe.stop();
    setPhase(exited ? "abort" : "finish");
  }
  // The black frame is rendered, so its send is in flight or skipped as identical, and the name is cleared.
  // Wait for both loops to end, but never longer than the cap.
  const grace = timer(CAP_SLACK_MS);
  await Promise.race([Promise.all([loop, nameLoop]), grace.done, cap?.done ?? grace.done]);
  // Whatever is still hanging must not send again.
  setPhase("abort");
  grace.cancel();
  cap?.cancel();
  return { startedUp: true, exited };
}
