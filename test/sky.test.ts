import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_OSINT } from "../src/around/sample";
import { lensCanvas } from "../src/core/board";
import { textWidth } from "../src/core/text";
import { BOARD_PLANES, DEMO_OSINT, demoScene } from "../src/sky/demo";
import {
  RH, RW, altitudeLabel, cleanAltitude, footerText, climbLabel, listLines, listText, othersAfter, renderSkyLens, selectedPlane, skyMessage, skyPlanes, skyTexts, stepSelection, type SkyModel,
} from "../src/sky/render";

const planes = BOARD_PLANES;
const model = (over: Partial<SkyModel> = {}): SkyModel => ({
  planes, selectedId: null, showCount: true, message: null, noPosition: false, clock: "18:16", open: 1, sweeping: true, ...over,
});
const draw = (m: SkyModel, t = 3.3): Uint8Array => {
  const c = lensCanvas();
  renderSkyLens(c, m, t);
  return c.pixels;
};
const lit = (pixels: Uint8Array, x0: number, y0: number, x1: number, y1: number): number => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((pixels[y * RW + x] ?? 0) > 0) n++;
  return n;
};

describe("the lens raster", () => {
  it("is 576 x 288 and still when nothing sweeps (identical frames are not sent)", () => {
    expect(draw(model())).toHaveLength(RW * RH);
    expect(draw(model({ sweeping: true }), 1)).not.toEqual(draw(model({ sweeping: true }), 1.4));
    expect(draw(model({ sweeping: false }), 1)).toEqual(draw(model({ sweeping: false }), 9.7));
  });
  it("draws the divider, the pixel clock, the footer and a lit you in the centre", () => {
    const f = draw(model());
    expect(lit(f, 292, 0, 293, 288)).toBeGreaterThan(50);
    expect(lit(f, 500, 7, 576, 21)).toBeGreaterThan(30);
    expect(lit(f, 300, 276, 576, 283)).toBeGreaterThan(50);
    expect(f[196 * RW + 144]).toBe(255);
  });
  it("shows CLIMBING, DESCENDING or LEVEL from the rate, and nothing when there is no rate", () => {
    expect(climbLabel(1200)).toBe("CLIMBING");
    expect(climbLabel(-1500)).toBe("DESCENDING");
    expect(climbLabel(200)).toBe("LEVEL");
    expect(climbLabel(-200)).toBe("LEVEL");
    expect(climbLabel(null)).toBeNull();
    const none = draw(model({ planes: planes.map((p) => ({ ...p, vrate: null })) }));
    expect(lit(none, 472, 65, 576, 72)).toBe(0);
    expect(lit(draw(model()), 472, 65, 576, 72)).toBeGreaterThan(20);
  });
  it("shows a dash for unknown values", () => {
    const blank = draw(model({ planes: [{ ...planes[0]!, alt: null, kt: null }] }));
    expect(lit(blank, 300, 97, 330, 111)).toBeGreaterThan(0);
    expect(lit(blank, 310, 97, 380, 111)).toBe(0);
    expect(blank).not.toEqual(draw(model()));
  });
  it("shrinks a long callsign instead of running into the arrow", () => {
    const f = draw(model({ planes: [{ ...planes[0]!, callsign: "ABCDEFGH" }] }));
    expect(lit(f, 442, 49, 452, 77)).toBe(0);
  });
  it("draws the header only when the feed is not known, and an empty body with nothing in range", () => {
    const header = draw(model({ showCount: false, planes: [] }));
    expect(lit(header, 300, 31, 576, 275)).toBe(0);
    expect(lit(header, 342, 8, 450, 20)).toBe(0);
    const empty = draw(model({ planes: [], sweeping: false }));
    expect(lit(empty, 300, 31, 576, 275)).toBe(0);
    expect(lit(empty, 342, 8, 450, 20)).toBeGreaterThan(0);
  });
  it("marks no position and an emergency", () => {
    expect(draw(model({ planes: [], noPosition: true, sweeping: false }))).not.toEqual(draw(model({ planes: [], sweeping: false })));
    const sos = draw(model({ planes: planes.map((p, i) => ({ ...p, emergency: i === 3 })) }));
    expect(sos).not.toEqual(draw(model()));
  });
  it("draws the selected aircraft in the panel and the others in the list numbers", () => {
    const third = draw(model({ selectedId: planes[2]!.id }));
    expect(third).not.toEqual(draw(model()));
  });
  it("at progress 1 is the normal picture, and frozen frames do not move with the clock", () => {
    expect(draw(model({ open: 1 }))).toEqual(draw(model()));
    for (const open of [0.1, 0.2, 0.6, 0.93]) expect(draw(model({ open }), 0)).toEqual(draw(model({ open }), 0));
    // The rings and the ladder first: nothing at the ladder before 0.30.
    expect(lit(draw(model({ open: 0.2 })), 0, 40, 30, 150)).toBe(0);
    // An aircraft is absent before the sweep passes its bearing (JWQ1173, 320 degrees).
    expect(lit(draw(model({ open: 0.44 + 0.56 * (300 / 360) })), 30, 40, 140, 110)).toBe(0);
    expect(lit(draw(model({ open: 0.44 + 0.56 * (345 / 360) })), 30, 40, 140, 150)).toBeGreaterThan(0);
  });
  it("with nothing in range the opening is over after the rings and the ladder", () => {
    const empty = { planes: [], sweeping: false };
    expect(draw(model({ ...empty, open: 0.44 }))).toEqual(draw(model({ ...empty, open: 1 })));
  });
});

describe("the list text", () => {
  it("holds the next three callsigns, with a blank line for a row the opening has not found", () => {
    expect(listText(model())).toBe("QXA1352\nZKV608\nJWQ1173");
    expect(listLines(model({ open: 0.3 }))).toEqual(["", "", ""]);
    expect(skyTexts(model({ open: 0.3 }))).toEqual([{ text: "Sky", x: 332, y: 0, level: 3 }]);
    expect(skyTexts(model())).toEqual([
      { text: "Sky", x: 332, y: 0, level: 3 },
      { text: "QXA1352", x: 300, y: 134, level: 2 },
      { text: "ZKV608", x: 300, y: 161, level: 2 },
      { text: "JWQ1173", x: 300, y: 188, level: 2 },
    ]);
  });
  it("says why there is nothing to list", () => {
    const p = SAMPLE_OSINT;
    expect(skyMessage(p, null, 0)).toBe("Nothing in range.");
    expect(skyMessage({ ...p, missing: ["aircraft"] }, null, 0)).toBe("No aircraft data.");
    expect(skyMessage({ ...p, connected: false, error: "No answer." }, null, 0)).toBe("The data feed is not reachable.\nNo answer.");
    expect(skyMessage({ ...p, me: null }, null, 0)).toBe("No position yet.");
    expect(skyMessage(null, null, 0)).toBe("Connecting…");
    expect(skyMessage(p, "HUD server is not reachable.", 4)).toBe("HUD server is not reachable.");
    expect(skyMessage(p, null, 4)).toBeNull();
  });
  it("wraps a notice by pixels to three lines", () => {
    const m = model({ planes: [], message: "No pairing key in the page URL. Open the app with npm run qr or npm run sim." });
    const lines = listText(m).split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(276);
  });
  it("builds the model's aircraft from a feed", () => {
    const fromFeed = skyPlanes(SAMPLE_OSINT);
    expect(fromFeed.map((p) => p.callsign)).toEqual(["XQT472", "QXA1352", "ZKV608", "JWQ1173"]);
    expect(fromFeed.every((p) => p.vrate === null)).toBe(true);
  });
});

describe("selection", () => {
  it("starts on the nearest and orders by distance", () => {
    expect(planes.map((p) => p.callsign)).toEqual(["XQT472", "QXA1352", "ZKV608", "JWQ1173"]);
    expect(selectedPlane(planes, null)?.callsign).toBe("XQT472");
  });
  it("steps out and in, and stops at the ends", () => {
    const out = stepSelection(planes, null, 1);
    expect(selectedPlane(planes, out)?.callsign).toBe("QXA1352");
    expect(stepSelection(planes, planes[3]!.id, 1)).toBe(planes[3]!.id);
    expect(stepSelection(planes, null, -1)).toBe(planes[0]!.id);
    expect(stepSelection(planes, planes[2]!.id, -1)).toBe(planes[1]!.id);
    expect(stepSelection([], null, 1)).toBeNull();
  });
  it("falls back to the nearest when the selected aircraft has left", () => {
    expect(selectedPlane(planes, "gone")?.callsign).toBe("XQT472");
  });
  it("lists the next three after the selected one, wrapping to the nearest", () => {
    expect(othersAfter(planes, planes[0]!).map((p) => p.callsign)).toEqual(["QXA1352", "ZKV608", "JWQ1173"]);
    expect(othersAfter(planes, planes[2]!).map((p) => p.callsign)).toEqual(["JWQ1173", "XQT472", "QXA1352"]);
    expect(othersAfter(planes.slice(0, 2), planes[0]!).map((p) => p.callsign)).toEqual(["QXA1352"]);
    expect(othersAfter([], null)).toEqual([]);
  });
});

describe("labels", () => {
  it("uses flight levels from 10,000 ft and thousands below", () => {
    expect(altitudeLabel(31000)).toBe("FL310");
    expect(altitudeLabel(10000)).toBe("FL100");
    expect(altitudeLabel(4500)).toBe("4.5K");
    expect(altitudeLabel(null)).toBe("-");
  });
});

describe("demo scenes", () => {
  it("keeps ?demo=1 and a bare ?demo as the live sample, and knows the problem scenes", () => {
    expect(demoScene("")).toBeNull();
    expect(demoScene("?demo")?.osint).toBe(DEMO_OSINT);
    expect(demoScene("?demo=1")?.osint).toBe(DEMO_OSINT);
    expect(demoScene("?demo=empty")?.osint?.aircraft).toEqual([]);
    expect(demoScene("?demo=nolink")?.link).toBe("closed");
    const stale = demoScene("?demo=stale")!;
    expect(stale.nowS - stale.osint!.at).toBeGreaterThan(60);
    expect(demoScene("?demo=nokey")?.serverError).toBeTruthy();
    expect(demoScene("?demo=nope")).toBeNull();
  });
});

describe("Sky page", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function boot() {
    vi.resetModules();
    vi.stubGlobal("location", { search: "?demo=1&intro=0&load=off", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null });
    vi.doMock("../src/core/net", () => ({ connectServer: () => ({ send: () => {}, close: () => {} }), MISSING_KEY_MESSAGE: "No pairing key." }));
    let handler: ((event: EvenHubEvent) => void) | null = null;
    const created: unknown[] = [];
    const upgrades: string[] = [];
    const bridge = {
      createStartUpPageContainer: async (spec: unknown) => (created.push(spec), StartUpPageCreateResult.success),
      textContainerUpgrade: async (u: { containerName: string; content: string }) => (upgrades.push(`${u.containerName}:${u.content}`), true),
      updateImageRawData: async () => 0,
      onEvenHubEvent: (h: (event: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/sky/main");
    await vi.waitFor(() => expect(handler).not.toBeNull());
    const send = (eventType: OsEventTypeList) => handler!({ sysEvent: { eventType } } as EvenHubEvent);
    return { created, upgrades, send };
  }

  it("opens one fixed page within the platform limits, images behind text", async () => {
    const { created, send } = await boot();
    const spec = created[0] as { imageObject: { containerName: string; containerID: number; width: number; height: number; zOrderIndex: number }[]; textObject: { containerName: string; containerID: number; isEventCapture: number; zOrderIndex: number }[] };
    expect(spec.imageObject.map((b) => b.containerName)).toEqual(["t00", "t10", "t01", "t11"]);
    expect(spec.textObject.map((b) => b.containerName)).toEqual(["status", "list"]);
    for (const b of spec.imageObject) {
      expect(b.width).toBeLessThanOrEqual(288);
      expect(b.height).toBeLessThanOrEqual(144);
    }
    const all = [...spec.imageObject, ...spec.textObject];
    expect(new Set(all.map((b) => b.containerID)).size).toBe(all.length);
    expect(new Set(all.map((b) => b.zOrderIndex)).size).toBe(all.length);
    expect(spec.textObject.filter((b) => b.isEventCapture === 1).map((b) => b.containerName)).toEqual(["list"]);
    expect(Math.max(...spec.imageObject.map((b) => b.zOrderIndex))).toBeLessThan(Math.min(...spec.textObject.map((b) => b.zOrderIndex)));
    send(OsEventTypeList.SYSTEM_EXIT_EVENT);
  });

  it("a swipe down selects the next aircraft out, a tap goes back to the nearest", async () => {
    const { upgrades, send } = await boot();
    send(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    await vi.waitFor(() => expect(upgrades.some((u) => u.startsWith("list:ZKV608\nJWQ1173\nXQT472"))).toBe(true));
    send(OsEventTypeList.CLICK_EVENT);
    await vi.waitFor(() => expect(upgrades.at(-1)).toBe("list:QXA1352\nZKV608\nJWQ1173"));
    send(OsEventTypeList.SYSTEM_EXIT_EVENT);
  });
});

describe("Sky frame rate", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.doUnmock("../src/core/imagepipe");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Boots the real page on a live feed (no demo, no opening) and returns the frame rate its image tiles ask for. */
  async function askedFps(aircraft: typeof SAMPLE_OSINT.aircraft): Promise<number[]> {
    vi.resetModules();
    vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null });
    const data = { ...SAMPLE_OSINT, aircraft };
    vi.doMock("../src/core/net", () => ({
      MISSING_KEY_MESSAGE: "No pairing key.",
      connectServer: (onMessage: (m: unknown) => void, onState: (open: boolean) => void) => {
        onState(true);
        onMessage({ type: "osint", data });
        return { send: () => {}, close: () => {} };
      },
    }));
    let producers: { fps: () => number }[] = [];
    vi.doMock("../src/core/imagepipe", () => ({
      ImagePipe: class {
        set(p: { fps: () => number }[]): void {
          producers = p;
        }
        run(): Promise<void> {
          return Promise.resolve();
        }
        poke(): void {}
        stop(): void {}
      },
    }));
    let handler: ((e: EvenHubEvent) => void) | null = null;
    const bridge = {
      createStartUpPageContainer: async () => StartUpPageCreateResult.success,
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      onEvenHubEvent: (h: (e: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/sky/main");
    await vi.waitFor(() => expect(producers.length).toBeGreaterThan(0));
    const rates = producers.map((p) => p.fps());
    handler!({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent);
    return rates;
  }

  it("sweeps (asks for frames) only while live traffic is in range, and is still otherwise", async () => {
    const busy = await askedFps(SAMPLE_OSINT.aircraft);
    expect(busy.every((fps) => fps > 0)).toBe(true);
    const empty = await askedFps([]);
    expect(empty.every((fps) => fps === 0)).toBe(true);
  });
});

describe("real values", () => {
  const plane = (over: Partial<(typeof planes)[number]> = {}) => ({ ...planes[0]!, ...over });
  it("names an open feed in the footer, with characters the pixel font has", () => {
    expect(footerText(undefined)).toBe("ADS-B  ·  1090 MHZ  ·  PI RECEIVER");
    expect(footerText(null)).toBe("ADS-B  ·  1090 MHZ  ·  PI RECEIVER");
    expect(footerText("adsb.fi")).toBe("ADS-B  ·  ADSB.FI");
    expect(footerText("air_planes~")).toBe("ADS-B  ·  AIRPLANES");
    expect(footerText("___")).toBe("ADS-B  ·  1090 MHZ  ·  PI RECEIVER");
    expect(draw(model({ source: "adsb.fi" }))).not.toEqual(draw(model()));
    expect(draw(model({ source: null }))).toEqual(draw(model()));
    // 24 characters is the longest source; it still fits the 276 px of the panel.
    expect(lit(draw(model({ source: "a".repeat(24) })), 570, 276, 576, 283)).toBe(0);
  });
  it("shows an altitude below zero as 0, everywhere, by one rule", () => {
    expect(cleanAltitude(-175)).toBe(0);
    expect(cleanAltitude(null)).toBeNull();
    expect(cleanAltitude(123456)).toBe(99_999);
    const low = skyPlanes({ ...SAMPLE_OSINT, aircraft: [{ ...SAMPLE_OSINT.aircraft[3]!, altitude_ft: -175 }] });
    expect(low[0]!.alt).toBe(0);
    expect(draw(model({ planes: low }))).toEqual(draw(model({ planes: [{ ...low[0]!, alt: 0 }] })));
    expect(altitudeLabel(low[0]!.alt)).toBe("0.0K");
  });
  it("fits the widest real values in the panel, the list and the header", () => {
    const wide = [plane({ callsign: "RYR98SA1", alt: 99_999, km: 59.9, kt: 999 }), plane({ id: "b", callsign: "RYR98SA1", alt: 45_000, km: 54.2, deg: 100 }), plane({ id: "c", callsign: "ABCDEFGH", alt: 99_999, km: 99.9, deg: 200 }), plane({ id: "d", callsign: "KLM84A", alt: 35_000, km: 33.1, deg: 300 })];
    const f = draw(model({ planes: wide }));
    // The panel tiles stay in their columns (separators at x 386 and 478).
    expect(lit(f, 372, 97, 386, 111)).toBe(0);
    expect(lit(f, 464, 97, 478, 111)).toBe(0);
    // The list: the altitude column ends at 500, the distance starts after it; nothing touches the edge or the gap.
    for (let row = 0; row < 3; row++) {
      const y0 = 134 + row * 27 + 7;
      expect(lit(f, 501, y0, 528, y0 + 14), `gap ${row}`).toBe(0);
      expect(lit(f, 300, y0, 428, y0 + 14), `callsign side ${row}`).toBe(0);
    }
    expect(lit(f, 530, 141, 576, 155)).toBeGreaterThan(0);
    // The callsign of 8 characters stops before the arrow; the header reads on one line.
    expect(lit(f, 442, 49, 452, 77)).toBe(0);
    expect(listLines(model({ planes: wide })).every((l) => textWidth(l) <= 124)).toBe(true);
    expect(textWidth("■ RYR98SA1")).toBeLessThanOrEqual(124);
  });
  it("keeps a label on the lens: a far east aircraft's label goes to its west, a very high one stays on screen", () => {
    const east = draw(model({ planes: [plane(), plane({ id: "e", callsign: "RYR98SA1", km: 50, deg: 85, alt: 5000 })] }));
    expect(lit(east, 286, 0, 292, 288)).toBe(0);
    const high = draw(model({ planes: [plane(), plane({ id: "h", callsign: "RYR98SA1", km: 59, deg: 0, alt: 45_000 })] }));
    expect(lit(high, 0, 0, 288, 2)).toBe(0);
  });
  it("reads as loading before the first aircraft answer, and as missing after it", () => {
    const missing = { ...SAMPLE_OSINT, aircraft: [], missing: ["aircraft" as const] };
    expect(skyMessage(missing, null, 0, true)).toBe("Looking for aircraft…");
    expect(skyMessage(missing, null, 0, false)).toBe("No aircraft data.");
    expect(skyMessage({ ...SAMPLE_OSINT, aircraft: [] }, null, 0, true)).toBe("Nothing in range.");
  });
});
