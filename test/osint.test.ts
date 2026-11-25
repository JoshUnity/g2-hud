import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopsFeed, getJson, toOsint } from "../server/loops";
import { BAND_Y, H, W, STALE_S, aroundStatus, compass, drawable, feedNotice, incidentLines, pulsePhase, renderAround } from "../src/around/render";
import { SAMPLE_MAP, SAMPLE_OSINT } from "../src/around/sample";
import type { Box } from "../src/core/box";
import type { LocalMap, Osint } from "../src/core/protocol";
import { bearing, metresBetween } from "../src/core/geo";
import { Canvas } from "../src/core/pixels";
import { tiled } from "../src/core/tiles";
import { RH, RW, planesInRange, renderSky, skyFps, skyLines } from "../src/sky/render";

describe("pixels", () => {
  it("fills a square with a dither at about the asked density", () => {
    const c = new Canvas(16, 16);
    c.fill([[[0, 0], [16, 0], [16, 16], [0, 16]]], 200, "dither", 0.5);
    expect([...c.pixels].filter((v) => v > 0).length).toBe(128);
  });
  it("draws pixel-font text and measures it", () => {
    const c = new Canvas(40, 10);
    expect(c.text(0, 0, "N1", 255)).toBe(12);
    expect(Canvas.textWidth("N1")).toBe(11);
  });
});

describe("tiles", () => {
  it("slices one frame into tiles, row by row", () => {
    const full = new Uint8Array(4 * 2).map((_, i) => i);
    const boxes: Box[] = [
      { id: 1, name: "l", x: 0, y: 0, width: 2, height: 2 },
      { id: 2, name: "r", x: 2, y: 0, width: 2, height: 2 },
    ];
    const [l, r] = tiled(boxes, { width: 4, height: 2 }, () => full, () => 1);
    expect([...(l?.render(0) ?? [])]).toEqual([0, 1, 4, 5]);
    expect([...(r?.render(0) ?? [])]).toEqual([2, 3, 6, 7]);
  });
});

describe("geometry", () => {
  it("measures distance and bearing", () => {
    const a = { lat: 47.2226, lon: -31.4851 };
    expect(metresBetween(a, { lat: 47.2316, lon: -31.4851 })).toBeCloseTo(995, -1);
    expect(bearing(a, { lat: 47.2326, lon: -31.4851 })).toBeCloseTo(0, 0);
    expect(compass(bearing(a, { lat: 47.2226, lon: -31.4751 }))).toBe("E");
  });
});

describe("Around app", () => {
  it("renders the full screen and clears the text band", () => {
    const frame = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 1);
    expect(frame).toHaveLength(W * H);
    const band = frame.subarray((BAND_Y + 4) * W);
    expect([...band].every((v) => v === 0)).toBe(true);
  });
  it("lists the most severe incidents first, with distance and direction", () => {
    const lines = incidentLines(SAMPLE_OSINT);
    expect(lines[0]).toMatch(/^■ 340 m SE /);
    expect(aroundStatus(SAMPLE_OSINT)).toContain("3 alerts");
  });
  it("says when Loops is away", () => {
    expect(incidentLines({ ...SAMPLE_OSINT, connected: false, error: "no route to host" })[0]).toContain("not reachable");
  });
  it("names no city it does not know", () => {
    const me = { lat: 35.68, lon: 139.76, heading: null, area: null };
    expect(aroundStatus({ ...SAMPLE_OSINT, me: { ...me, source: "gps" } })).toContain("·  Here  ·");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: { ...me, source: "home" } })).toContain("·  Home  ·");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: null })).toContain("·  No fix  ·");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: null })).not.toContain(SAMPLE_OSINT.me?.area ?? "Harbour Quarter");
  });
  it("says when the incident list is unknown, not quiet", () => {
    const osint = { ...SAMPLE_OSINT, items: [], missing: ["items" as const] };
    expect(incidentLines(osint)).toEqual(["No incident data from Loops."]);
    expect(aroundStatus(osint)).toContain("? alerts");
    expect(incidentLines({ ...SAMPLE_OSINT, items: [] })).toEqual(["All quiet nearby."]);
  });
  it("pulses the critical ring outwards at the 1 fps it is drawn at", () => {
    const phases = [0, 1, 2, 3].map(pulsePhase);
    for (let i = 1; i < phases.length; i++) expect(phases[i]).toBeGreaterThan(phases[i - 1] ?? 1);
  });
});

describe("demo data", () => {
  /** The demo town moved by `d` degrees of longitude, every point by the same amount. */
  function shifted(d: number): { map: LocalMap; osint: Osint } {
    const p = ([lat, lon]: [number, number]): [number, number] => [lat, lon + d];
    const o = SAMPLE_OSINT;
    return {
      map: {
        center: { ...SAMPLE_MAP.center, lon: SAMPLE_MAP.center.lon + d },
        roads: SAMPLE_MAP.roads.map((r) => ({ ...r, points: r.points.map(p) })),
        water: SAMPLE_MAP.water.map((ring) => ring.map(p)),
        green: SAMPLE_MAP.green.map((ring) => ring.map(p)),
      },
      osint: {
        ...o,
        me: o.me && { ...o.me, lon: o.me.lon + d },
        items: o.items.map((i) => ({ ...i, lon: i.lon === null ? null : i.lon + d, lines: i.lines.map((l) => l.map(p)) })),
        aircraft: o.aircraft.map((a) => ({ ...a, lon: a.lon + d, trail: a.trail.map(p) })),
        vehicles: o.vehicles.map((v) => ({ ...v, lon: v.lon + d })),
      },
    };
  }
  it("draws the same map and radar wherever the invented town sits", () => {
    // Only offsets from `me` are drawn, so the demo place can move without changing a pixel.
    const { map, osint } = shifted(3);
    for (const t of [0, 1, 2.5]) {
      expect(renderAround(map, osint, t)).toEqual(renderAround(SAMPLE_MAP, SAMPLE_OSINT, t));
      expect(renderSky(osint, t)).toEqual(renderSky(SAMPLE_OSINT, t));
    }
  });
});

describe("feed state on the glasses", () => {
  const now = SAMPLE_OSINT.at;
  it("shows the missing pairing key and a lost server instead of old data", () => {
    expect(feedNotice(SAMPLE_OSINT, "closed", "No pairing key", now)).toBe("No pairing key");
    expect(feedNotice(SAMPLE_OSINT, "closed", null, now)).toBe("HUD server is not reachable.");
    expect(feedNotice(SAMPLE_OSINT, "open", null, now)).toBeNull();
    expect(feedNotice(null, "connecting", null, now)).toBeNull();
  });
  it("says when a connected feed has gone quiet", () => {
    expect(feedNotice(SAMPLE_OSINT, "open", null, now + STALE_S - 1)).toBeNull();
    expect(feedNotice(SAMPLE_OSINT, "open", null, now + 180)).toBe("No update from Loops for 3 min.");
    // Loops away: the "not reachable" text stays, the age is not shown.
    expect(feedNotice({ ...SAMPLE_OSINT, connected: false }, "open", null, now + 600)).toBeNull();
  });
  it("draws the moving layers only while live", () => {
    expect(drawable(SAMPLE_OSINT, true)).toBe(SAMPLE_OSINT);
    const still = drawable(SAMPLE_OSINT, false);
    expect(still).toMatchObject({ items: [], aircraft: [], vehicles: [], me: SAMPLE_OSINT.me });
    expect(drawable(null, false)).toBeNull();
  });
});

describe("Sky app", () => {
  it("renders a full-height radar that sweeps", () => {
    expect(renderSky(SAMPLE_OSINT, 1)).toHaveLength(RW * RH);
    expect(renderSky(SAMPLE_OSINT, 1)).not.toEqual(renderSky(SAMPLE_OSINT, 1.5));
  });
  it("lists aircraft nearest first, two lines each", () => {
    expect(planesInRange(SAMPLE_OSINT)[0]?.callsign).toBe("XQT472");
    expect(skyLines(SAMPLE_OSINT)[1]).toContain("1,800 ft");
  });
  it("does not call an aircraft with no altitude on the ground", () => {
    const plane = { ...SAMPLE_OSINT.aircraft[3]!, altitude_ft: null };
    const line = skyLines({ ...SAMPLE_OSINT, aircraft: [plane] })[1];
    expect(line).not.toContain("on ground");
    expect(line).toMatch(/^ {3}0\.\d km · 150 kt$/);
  });
  it("says when the aircraft list is unknown, not empty", () => {
    expect(skyLines({ ...SAMPLE_OSINT, aircraft: [], missing: ["aircraft"] })).toEqual(["No aircraft data from Loops."]);
    expect(skyLines({ ...SAMPLE_OSINT, aircraft: [] })).toEqual(["Nothing in range."]);
  });
  it("sweeps at 1 fps only with live traffic, and is still otherwise", () => {
    expect(skyFps(SAMPLE_OSINT)).toBe(1);
    expect(skyFps(null)).toBe(0);
    expect(skyFps({ ...SAMPLE_OSINT, connected: false })).toBe(0);
    const quiet = { ...SAMPLE_OSINT, aircraft: [] };
    expect(skyFps(quiet)).toBe(0);
    expect(renderSky(quiet, 1)).toEqual(renderSky(quiet, 2.5));
    expect(renderSky(null, 1)).toEqual(renderSky(null, 2.5));
  });
});

describe("app exit", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Loads an app's main module with a fake host and socket; returns the event handler and the spies. */
  async function boot(app: "around" | "sky") {
    vi.resetModules();
    vi.stubGlobal("location", { search: "?k=key", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null });
    const close = vi.fn();
    vi.doMock("../src/core/net", () => ({
      connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => false, close }),
    }));
    let handler: ((event: EvenHubEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const bridge = {
      createStartUpPageContainer: async () => StartUpPageCreateResult.success,
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      onEvenHubEvent: (h: (event: EvenHubEvent) => void) => {
        handler = h;
        return unsubscribe;
      },
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    const { ImagePipe } = await import("../src/core/imagepipe");
    const stop = vi.spyOn(ImagePipe.prototype, "stop");
    const clear = vi.spyOn(globalThis, "clearInterval");
    await import(app === "around" ? "../src/around/main" : "../src/sky/main");
    await vi.waitFor(() => expect(handler).not.toBeNull());
    const send = (eventType: OsEventTypeList) => handler!({ sysEvent: { eventType } } as EvenHubEvent);
    return { send, close, unsubscribe, stop, clear };
  }

  for (const app of ["around", "sky"] as const) {
    it(`${app}: keeps running through a menu, releases everything on a system exit`, async () => {
      const { send, close, unsubscribe, stop, clear } = await boot(app);
      send(OsEventTypeList.FOREGROUND_EXIT_EVENT);
      send(OsEventTypeList.FOREGROUND_ENTER_EVENT);
      expect(close).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      send(OsEventTypeList.SYSTEM_EXIT_EVENT);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    });
  }

  it("around: an abnormal exit releases everything too, once", async () => {
    const { send, close, stop } = await boot("around");
    send(OsEventTypeList.ABNORMAL_EXIT_EVENT);
    send(OsEventTypeList.SYSTEM_EXIT_EVENT);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("Loops bridge", () => {
  it("reads the envelope over a Unix socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loops-"));
    const socketPath = join(dir, "api.sock");
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/ok") res.end(JSON.stringify({ success: true, data: { hello: 1 }, error: null }));
      else res.end(JSON.stringify({ success: false, data: null, error: "Unknown id" }));
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      expect(await getJson(socketPath, "/v1/ok")).toEqual({ hello: 1 });
      await expect(getJson(socketPath, "/v1/nope")).rejects.toThrow("Unknown id");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims the city view to what is near, and merges aircraft trails", () => {
    const me = { lat: 47.2311, lon: -31.4826 };
    const osint = toOsint(
      {
        location: { fix: { lat: me.lat, lon: me.lon, heading_deg: 90 }, area: "Harbour Quarter" },
        items: [
          { id: "near", feed: "f", kind: "closure", severity: 1, title: "Near", lat: 47.2316, lon: -31.4821, updated_at: 1 },
          { id: "far", feed: "f", kind: "closure", severity: 1, title: "Far", lat: 47.3226, lon: -31.6451, updated_at: 1 },
          { id: "big", feed: "f", kind: "fire", severity: 3, title: "Big fire", lat: 47.4226, lon: -31.6451, updated_at: 1 },
        ],
        aircraft: { aircraft: [{ id: "abc", callsign: "QXA1 ", lat: 47.2726, lon: -31.4451, altitude_ft: 3000, track: 10 }] },
        live: { vehicles: [], aircraft: [{ id: "abc", lat: 47.2726, lon: -31.4451, trail: [[47.2226, -31.3451]], updated_at: 1 }] },
        map: null,
      },
      1000,
    );
    expect(osint.me).toMatchObject({ source: "gps", area: "Harbour Quarter", heading: 90 });
    // Ranked before the cut: most severe first, then nearest.
    expect(osint.items.map((i) => i.id)).toEqual(["big", "near"]);
    expect(osint.aircraft[0]).toMatchObject({ callsign: "QXA1", trail: [[47.2226, -31.3451]] });
  });

  it("refuses a target that ssh could read as an option", () => {
    expect(() => new LoopsFeed("-oProxyCommand=x", () => {}, () => {})).toThrow();
  });
});
