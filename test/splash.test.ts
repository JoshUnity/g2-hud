import {
  ImageRawDataUpdateResult,
  OsEventTypeList,
  StartUpPageCreateResult,
  evenHubEventFromJson,
  type CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  type ImageRawDataUpdate,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICON as SKY_ICON, ORDER as SKY_ORDER } from "../src/sky/icon";
import { textWidth } from "../src/core/text";
import { SPLASH_MARK, SPLASH_MS, SPLASH_NAME_Y, introParam, playSplash, renderSplash, splashFrame, splashName, type SplashSpec } from "../src/core/splash";

/** The Sky icon, drawn from the bottom up. */
const spec: SplashSpec = { name: "Answers", icon: SKY_ICON, order: SKY_ORDER };
/** One lit cell at the top left, which appears at once. */
const single: SplashSpec = { name: "X", icon: ["#...........", ...Array.from({ length: 11 }, () => ".".repeat(12))], order: () => 0 };
const values = (frame: Uint8Array) => new Set([...frame].filter((v) => v > 0));

describe("splashFrame", () => {
  it("draws with ease-out cubic over 900 ms", () => {
    expect(splashFrame(0)).toEqual({ ms: 0, t: 0, draw: 0, pulse: 0 });
    expect(splashFrame(450).draw).toBeCloseTo(0.875, 6);
    expect(splashFrame(900).draw).toBe(1);
    expect(splashFrame(1500).draw).toBe(1);
    expect(splashFrame(500).t).toBe(0.5);
  });

  it("pulses once from 900 to 1250 ms", () => {
    expect(splashFrame(899).pulse).toBe(0);
    expect(splashFrame(900).pulse).toBe(1);
    expect(splashFrame(1075).pulse).toBeCloseTo(0.5, 6);
    expect(splashFrame(1250).pulse).toBe(0);
    expect(splashFrame(1400).pulse).toBe(0);
  });
});

describe("renderSplash", () => {
  it("is one 96 x 96 frame, and the mark is centred on the lens", () => {
    expect(renderSplash(spec, 0)).toHaveLength(96 * 96);
    expect(SPLASH_MARK).toMatchObject({ id: 1, x: 240, y: 70, width: 96, height: 96 });
    expect(SPLASH_MARK.x + SPLASH_MARK.width / 2).toBe(288);
    expect(SPLASH_NAME_Y).toBe(184);
  });

  it("draws a lit cell as a 6 x 6 square on an 8 px pitch", () => {
    const frame = renderSplash(single, 1100);
    const at = (x: number, y: number) => frame[y * 96 + x];
    expect(at(0, 0)).toBe(255); // hot during the pulse
    expect(at(5, 5)).toBe(255);
    expect(at(6, 0)).toBe(0);
    expect(at(0, 6)).toBe(0);
    expect([...frame].filter((v) => v > 0)).toHaveLength(36);
    const two: SplashSpec = { name: "X", icon: ["##..........", ...Array.from({ length: 11 }, () => ".".repeat(12))], order: () => 0 };
    const pair = renderSplash(two, 1100);
    expect(pair[0 * 96 + 8]).toBe(255);
    expect(pair[5 * 96 + 13]).toBe(255);
    expect(pair[0 * 96 + 14]).toBe(0);
  });

  it("uses only crisp values: 0, 187 and 255", () => {
    for (let ms = 0; ms < SPLASH_MS; ms += 50) for (const v of renderSplash(spec, ms)) expect([0, 187, 255]).toContain(v);
  });

  it("lights a cell once its order is reached, and keeps it", () => {
    const early = renderSplash(spec, 100);
    const late = renderSplash(spec, 800);
    expect([...late].filter((v) => v > 0).length).toBeGreaterThan([...early].filter((v) => v > 0).length);
    early.forEach((v, i) => {
      if (v > 0) expect(late[i]).toBeGreaterThan(0);
    });
    // Sky builds from the tail (bottom) up: the bottom row is lit before the top row.
    const bottom = (frame: Uint8Array, row: number) => frame[(row * 8 + 2) * 96 + 5 * 8];
    expect(bottom(early, 11)).toBeGreaterThan(0);
    expect(bottom(early, 0)).toBe(0);
  });

  it("is hot for a moment after a cell appears, and settles to 187", () => {
    const timed: SplashSpec = { name: "X", icon: single.icon, order: () => 0.5 };
    // draw(ms) = 1 - (1 - ms / 900) ** 3: find a time with draw just past 0.5, and one well past it.
    const justAfter = renderSplash(timed, 900 * (1 - 0.5 ** (1 / 3)) + 5);
    expect(justAfter[0]).toBe(255);
    expect(renderSplash(timed, 700)[0]).toBe(187);
  });

  it("pulses: every lit cell is at full light from 900 to 1250 ms", () => {
    expect(values(renderSplash(spec, 900))).toEqual(new Set([255]));
    expect(values(renderSplash(spec, 1200))).toEqual(new Set([255]));
    expect(values(renderSplash(spec, 1260))).toEqual(new Set([187]));
  });

  it("goes dark cell by cell from 1300 to 1600 ms and is black at 1600", () => {
    const lit = (ms: number) => [...renderSplash(spec, ms)].filter((v) => v > 0).length;
    expect(lit(1300)).toBe(lit(1260));
    expect(lit(1400)).toBeLessThan(lit(1300));
    expect(lit(1500)).toBeLessThan(lit(1400));
    expect(lit(1590)).toBeLessThan(lit(1500));
    // Cells go out whole: a hidden cell never comes back later.
    const before = renderSplash(spec, 1400);
    renderSplash(spec, 1500).forEach((v, i) => {
      if (v > 0) expect(before[i]).toBeGreaterThan(0);
    });
    expect(renderSplash(spec, SPLASH_MS).every((v) => v === 0)).toBe(true);
    expect(renderSplash(spec, 3000).every((v) => v === 0)).toBe(true);
  });
});

describe("splashName", () => {
  it("is empty before 500 ms", () => expect(splashName(spec, 499)).toEqual({ content: "", color: 4 }));

  it("types the name in from 500 to 1000 ms, in light 4", () => {
    const shown = [501, 600, 700, 800, 900, 1000].map((ms) => splashName(spec, ms).content);
    expect(shown[0]).toBe("A");
    shown.forEach((text, i) => {
      expect("Answers".startsWith(text)).toBe(true);
      if (i > 0) expect(text.length).toBeGreaterThanOrEqual(shown[i - 1]?.length ?? 0);
    });
    expect(splashName(spec, 1000)).toEqual({ content: "Answers", color: 4 });
    expect(splashName(spec, 1299)).toEqual({ content: "Answers", color: 4 });
  });

  it("shows ceil((ms - 500) / 500 * length) letters", () => {
    expect(splashName(spec, 600).content).toBe("Answers".slice(0, Math.ceil((100 / 500) * 7)));
    expect(splashName({ ...spec, name: "Sky" }, 800).content).toBe("Sky".slice(0, Math.ceil((300 / 500) * 3)));
  });

  it("steps back in light in thirds of the out phase, then clears at 1600 ms", () => {
    expect(splashName(spec, 1300).color).toBe(4); // the board: the step back starts after 1300 ms
    expect(splashName(spec, 1301).color).toBe(3);
    expect(splashName(spec, 1390).color).toBe(3);
    expect(splashName(spec, 1410).color).toBe(2);
    expect(splashName(spec, 1490).color).toBe(2);
    expect(splashName(spec, 1510).color).toBe(1);
    expect(splashName(spec, 1599)).toEqual({ content: "Answers", color: 1 });
    expect(splashName(spec, 1600).content).toBe("");
    expect(splashName(spec, 5000).content).toBe("");
  });
});

describe("introParam", () => {
  it("skips on intro=0", () => expect(introParam("?intro=0")).toEqual({ skip: true, freezeMs: null }));
  it("freezes at a positive number of ms", () => {
    expect(introParam("?demo=1&intro=900")).toEqual({ skip: false, freezeMs: 900 });
    expect(introParam("?intro=12.5")).toEqual({ skip: false, freezeMs: 12.5 });
  });
  it("plays normally otherwise", () => {
    for (const search of ["", "?demo=1", "?intro=", "?intro=abc", "?intro=-5"]) expect(introParam(search)).toEqual({ skip: false, freezeMs: null });
  });
});

type Fake = ReturnType<typeof fakeBridge>;

function fakeBridge(
  options: { create?: () => Promise<StartUpPageCreateResult>; send?: () => Promise<ImageRawDataUpdateResult>; upgrade?: () => Promise<boolean> } = {},
) {
  const calls: string[] = [];
  const pages: CreateStartUpPageContainer[] = [];
  const frames: { id: number | undefined; name: string | undefined; data: Uint8Array }[] = [];
  const upgrades: { id: number | undefined; name: string | undefined; content: string | undefined; color: number | undefined; at: number }[] = [];
  let upgradesInFlight = 0;
  let mostUpgrades = 0;
  let inFlight = 0;
  let most = 0;
  let listener: ((event: EvenHubEvent) => void) | null = null;
  let unsubscribed = 0;
  const bridge = {
    createStartUpPageContainer: async (page: CreateStartUpPageContainer) => {
      calls.push("create");
      pages.push(page);
      return options.create ? options.create() : StartUpPageCreateResult.success;
    },
    updateImageRawData: async (update: ImageRawDataUpdate) => {
      calls.push("image");
      most = Math.max(most, ++inFlight);
      frames.push({ id: update.containerID, name: update.containerName, data: new Uint8Array(update.imageData as Uint8Array) });
      try {
        return options.send ? await options.send() : ImageRawDataUpdateResult.success;
      } finally {
        inFlight--;
      }
    },
    textContainerUpgrade: async (upgrade: TextContainerUpgrade) => {
      calls.push("text");
      mostUpgrades = Math.max(mostUpgrades, ++upgradesInFlight);
      upgrades.push({ id: upgrade.containerID, name: upgrade.containerName, content: upgrade.content, color: upgrade.textColor, at: Date.now() });
      try {
        return options.upgrade ? await options.upgrade() : true;
      } finally {
        upgradesInFlight--;
      }
    },
    onEvenHubEvent: (fn: (event: EvenHubEvent) => void) => {
      calls.push("subscribe");
      listener = fn;
      return () => {
        unsubscribed++;
        listener = null;
      };
    },
  } as unknown as EvenAppBridge;
  return {
    bridge,
    calls,
    pages,
    frames,
    upgrades,
    mostUpgrades: () => mostUpgrades,
    most: () => most,
    unsubscribed: () => unsubscribed,
    emit: (event: EvenHubEvent) => listener?.(event),
  };
}

const exitEvent = (type: OsEventTypeList) => evenHubEventFromJson({ type: "sysEvent", jsonData: { eventType: type } });

describe("playSplash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs the splash and moves the fake clock until it settles. */
  async function play(f: Fake, ms = 4000) {
    const result = playSplash(f.bridge, spec);
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  }

  it("makes a start-up page of two containers with one event capture", async () => {
    const f = fakeBridge();
    await play(f);
    const page = f.pages[0];
    expect(f.pages).toHaveLength(1);
    expect(page?.containerTotalNum).toBe(2);
    expect(page?.imageObject).toHaveLength(1);
    expect(page?.imageObject?.[0]).toMatchObject({ containerID: 1, containerName: "splash", xPosition: 240, yPosition: 70, width: 96, height: 96 });
    expect(page?.textObject).toHaveLength(1);
    expect((page?.textObject ?? []).filter((t) => t.isEventCapture === 1)).toHaveLength(1);
    const name = page?.textObject?.[0];
    expect(name).toMatchObject({ content: "", isEventCapture: 1, paddingLength: 0, yPosition: SPLASH_NAME_Y, height: 27 });
    // Centred by pixel width, and wide enough that the firmware never wraps it.
    const width = textWidth("Answers");
    expect(name?.xPosition).toBe(Math.round((576 - width) / 2));
    expect(name?.width).toBeGreaterThan(width);
    expect((name?.xPosition ?? 0) + (name?.width ?? 0)).toBeLessThanOrEqual(576);
  });

  it("sends frames only to the splash, one at a time, and ends on a black frame", async () => {
    const f = fakeBridge({ send: () => new Promise((r) => setTimeout(() => r(ImageRawDataUpdateResult.success), 30)) });
    const result = await play(f);
    expect(result).toEqual({ startedUp: true, exited: false });
    expect(f.frames.length).toBeGreaterThan(5);
    expect(f.frames.every((fr) => fr.id === SPLASH_MARK.id && fr.name === SPLASH_MARK.name && fr.data.length === 96 * 96)).toBe(true);
    expect(f.most()).toBe(1);
    expect(f.frames.at(-1)?.data.every((v) => v === 0)).toBe(true);
    expect(f.unsubscribed()).toBe(1);
  });

  it("sends nothing more after it returns", async () => {
    const f = fakeBridge();
    await play(f);
    const sent = f.frames.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.frames).toHaveLength(sent);
  });

  it("does not run longer than the intro on a slow link", async () => {
    const f = fakeBridge({ send: () => new Promise((r) => setTimeout(() => r(ImageRawDataUpdateResult.success), 400)) });
    let done = false;
    void playSplash(f.bridge, spec).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(SPLASH_MS + 800);
    expect(done).toBe(true);
    expect(f.frames.at(-1)?.data.every((v) => v === 0)).toBe(true);
  });

  it("returns within the cap when image sends hang", async () => {
    const f = fakeBridge({ send: () => new Promise(() => undefined) });
    let done = false;
    const result = playSplash(f.bridge, spec).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(SPLASH_MS + 1500 + 50);
    expect(done).toBe(true);
    expect(await result).toEqual({ startedUp: true, exited: false });
  });

  it("keeps the name current with upgrades: one at a time, only on a change, and ends on the empty string", async () => {
    const f = fakeBridge({ upgrade: () => new Promise((r) => setTimeout(() => r(true), 30)) });
    await play(f);
    expect(f.upgrades.length).toBeGreaterThan(5);
    expect(f.mostUpgrades()).toBe(1);
    expect(f.upgrades.every((u) => u.id === 2 && u.name === "splash-name")).toBe(true);
    // Only changes: no two neighbours carry the same text and light.
    f.upgrades.forEach((u, i) => {
      const prev = f.upgrades[i - 1];
      if (prev) expect(`${u.color}|${u.content}`).not.toBe(`${prev.color}|${prev.content}`);
    });
    // The letters grow, the full name appears at light 4, then the light steps down, and the last upgrade is "".
    const contents = f.upgrades.map((u) => u.content ?? "");
    expect(contents[0]).not.toBe("");
    expect(contents).toContain("Answers");
    expect(f.upgrades.find((u) => u.content === "Answers")?.color).toBe(4);
    expect(f.upgrades.map((u) => u.color)).toEqual(expect.arrayContaining([3, 2, 1]));
    expect(f.upgrades.at(-1)).toMatchObject({ content: "", color: 1 });
  });

  it("sends no name upgrade after it returns, and none when it exits", async () => {
    const f = fakeBridge();
    await play(f);
    const sent = f.upgrades.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.upgrades).toHaveLength(sent);

    const g = fakeBridge();
    void playSplash(g.bridge, spec);
    await vi.advanceTimersByTimeAsync(700);
    g.emit(exitEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await vi.advanceTimersByTimeAsync(100);
    const after = g.upgrades.length;
    expect(after).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(g.upgrades).toHaveLength(after);
  });

  it("retries a refused name upgrade, and still returns on time when upgrades hang", async () => {
    let n = 0;
    const f = fakeBridge({ upgrade: async () => ++n > 2 });
    await play(f);
    expect(n).toBeGreaterThan(3);

    const g = fakeBridge({ upgrade: () => new Promise(() => undefined) });
    let done = false;
    const result = playSplash(g.bridge, spec).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(SPLASH_MS + 1500 + 50);
    expect(done).toBe(true);
    expect(await result).toEqual({ startedUp: true, exited: false });
    expect(g.upgrades).toHaveLength(1); // the hung send is the only one
  });

  it("sends no images when the create is refused", async () => {
    for (const refused of [StartUpPageCreateResult.invalid, StartUpPageCreateResult.oversize]) {
      const f = fakeBridge({ create: async () => refused });
      expect(await play(f)).toEqual({ startedUp: false, exited: false });
      expect(f.calls).toEqual(["create"]);
    }
  });

  it("treats a create that never answers as not created, after 3 s", async () => {
    const f = fakeBridge({ create: () => new Promise(() => undefined) });
    let done = false;
    const result = playSplash(f.bridge, spec).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(await result).toEqual({ startedUp: false, exited: false });
    expect(f.calls).toEqual(["create"]);
  });

  it("makes no bridge call with intro=0", async () => {
    vi.stubGlobal("location", { search: "?intro=0" });
    const f = fakeBridge();
    expect(await play(f)).toEqual({ startedUp: false, exited: false });
    expect(f.calls).toEqual([]);
  });

  it.each([OsEventTypeList.SYSTEM_EXIT_EVENT, OsEventTypeList.ABNORMAL_EXIT_EVENT])("stops early on an exit event (%s)", async (type) => {
    const f = fakeBridge();
    let result: Awaited<ReturnType<typeof playSplash>> | undefined;
    void playSplash(f.bridge, spec).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(300);
    f.emit(exitEvent(OsEventTypeList.FOREGROUND_EXIT_EVENT)); // not an exit
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBeUndefined();
    f.emit(exitEvent(type));
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toEqual({ startedUp: true, exited: true });
    const sent = f.frames.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.frames).toHaveLength(sent);
    expect(f.unsubscribed()).toBe(1);
  });

  it("holds the frozen time until the app exits", async () => {
    vi.stubGlobal("location", { search: "?intro=1100" });
    const f = fakeBridge();
    let result: Awaited<ReturnType<typeof playSplash>> | undefined;
    void playSplash(f.bridge, spec).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(6000);
    expect(result).toBeUndefined();
    expect(f.frames).toHaveLength(1); // identical frames are skipped
    expect(f.frames[0]?.data).toEqual(renderSplash(spec, 1100));
    expect(f.upgrades).toHaveLength(1); // the frozen name is sent once
    expect(f.upgrades[0]).toMatchObject({ content: "Answers", color: 4 });
    f.emit(exitEvent(OsEventTypeList.SYSTEM_EXIT_EVENT));
    await vi.advanceTimersByTimeAsync(300); // the idle pipe loop ends within 250 ms
    expect(result).toEqual({ startedUp: true, exited: true });
  });
});
