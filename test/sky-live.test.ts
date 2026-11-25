import { ImageRawDataUpdateResult, OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LENS_TILES, lensCanvas } from "../src/core/board";
import { calibrate } from "../src/core/calibrate";
import type { Osint } from "../src/core/protocol";
import { clockText } from "../src/core/text";
import { DEMO_OSINT } from "../src/sky/demo";
import { renderSkyLens, skyPlanes } from "../src/sky/render";

/** The real page on a real feed: no demo, a mocked connection and a mocked host. */
describe("Sky on a live feed", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // The board's aircraft, but the nearest descends, and one has no rate at all.
  const feed: Osint = {
    ...DEMO_OSINT,
    at: Date.now() / 1000,
    aircraft: DEMO_OSINT.aircraft.map((a, i) => (i === 0 ? { ...a, vrate: -500 } : i === 3 ? { ...a, vrate: undefined } : a)),
  };

  /** The third argument of every connectServer call: the server picks its feed from it. */
  const appNames: (string | undefined)[] = [];

  async function boot(data: Osint = feed) {
    appNames.length = 0;
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 25, 9, 41, 30));
    // Time stands still for the image pipe, so the sweep and the pipe's clock are at t = 0 for every tile.
    vi.spyOn(performance, "now").mockReturnValue(5000);
    vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null });
    vi.doMock("../src/core/net", () => ({
      MISSING_KEY_MESSAGE: "No pairing key.",
      connectServer: (onMessage: (m: unknown) => void, onState: (open: boolean) => void, name?: string) => {
        appNames.push(name);
        onState(true);
        onMessage({ type: "osint", data: { ...data, at: Date.now() / 1000 } });
        return { send: () => {}, close: () => {} };
      },
    }));
    type Spec = { imageObject: { containerID: number }[]; textObject: { containerName: string; content: string; xPosition: number; yPosition: number; textColor: number }[] };
    const created: Spec[] = [];
    const sent = new Map<number, Uint8Array>();
    let handler: ((e: EvenHubEvent) => void) | null = null;
    const bridge = {
      createStartUpPageContainer: async (spec: Spec) => (created.push(spec), StartUpPageCreateResult.success),
      textContainerUpgrade: async () => true,
      updateImageRawData: async (u: { containerID: number; imageData: ArrayLike<number> | string }) => {
        sent.set(u.containerID, Uint8Array.from(u.imageData as ArrayLike<number>));
        return ImageRawDataUpdateResult.success;
      },
      onEvenHubEvent: (h: (e: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/sky/main");
    await vi.waitFor(() => expect(created).toHaveLength(1));
    await vi.waitFor(() => expect(sent.size).toBe(4), { timeout: 5000 });
    return { created: created[0]!, sent, stop: () => handler!({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent) };
  }

  it("connects to the server as the sky app", async () => {
    await boot();
    expect(appNames).toEqual(["sky"]);
  });

  it("puts the feed's texts on the page and sends four tiles that make the renderer's frame", async () => {
    const { created, sent, stop } = await boot();
    // The glasses font: the status and the next three callsigns, nearest first.
    const text = (name: string) => created.textObject.find((t) => t.containerName === name)!;
    expect(text("status")).toMatchObject({ content: "Sky", xPosition: 332, yPosition: 0, textColor: 3 });
    expect(text("list")).toMatchObject({ content: "QXA1352\nZKV608\nJWQ1173", xPosition: 300, yPosition: 134, textColor: 2 });

    // The four tiles, put back together, are the frame the renderer draws for this feed.
    const stitched = new Uint8Array(576 * 288);
    for (const tile of LENS_TILES) {
      const pixels = sent.get(tile.id)!;
      expect(pixels).toHaveLength(tile.width * tile.height);
      for (let y = 0; y < tile.height; y++) stitched.set(pixels.subarray(y * tile.width, (y + 1) * tile.width), (tile.y + y) * 576 + tile.x);
    }
    const expected = lensCanvas();
    renderSkyLens(
      expected,
      { planes: skyPlanes(feed), selectedId: null, showCount: true, message: null, noPosition: false, clock: clockText(new Date()), open: 1, sweeping: true },
      0,
    );
    expect(stitched).toEqual(calibrate(expected.pixels));
    // The rate reached the panel: DESCENDING shows, and the board's CLIMBING (a different rate) does not.
    const wrong = lensCanvas();
    renderSkyLens(wrong, { planes: skyPlanes(DEMO_OSINT), selectedId: null, showCount: true, message: null, noPosition: false, clock: clockText(new Date()), open: 1, sweeping: true }, 0);
    expect(stitched).not.toEqual(calibrate(wrong.pixels));
    expect(clockText(new Date())).toBe("09:41");
    stop();
  });

  it("names an open feed in the footer, and reads as loading before the first aircraft answer", async () => {
    const { created, sent, stop } = await boot({ ...feed, aircraftSource: "adsb.fi", aircraft: [], missing: ["aircraft"] });
    expect(created.textObject.find((t) => t.containerName === "list")!.content).toBe("Looking for aircraft…");
    const expected = lensCanvas();
    renderSkyLens(expected, { planes: [], selectedId: null, showCount: true, message: "x", noPosition: false, clock: clockText(new Date()), open: 1, sweeping: false, source: "adsb.fi" }, 0);
    const stitched = new Uint8Array(576 * 288);
    for (const tile of LENS_TILES) for (let y = 0; y < tile.height; y++) stitched.set(sent.get(tile.id)!.subarray(y * tile.width, (y + 1) * tile.width), (tile.y + y) * 576 + tile.x);
    expect(stitched).toEqual(calibrate(expected.pixels));
    stop();
  });
});
