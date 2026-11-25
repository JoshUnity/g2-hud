import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopsFeed, getJson, toOsint } from "../server/loops";
import { BAND_Y, H, W, STALE_S, aroundStatus, compass, drawable, feedNotice, incidentRows, messageLines, pulseRadius, renderAround, summaryText } from "../src/around/render";
import { SAMPLE_MAP, SAMPLE_OSINT } from "../src/around/sample";
import type { Box } from "../src/core/box";
import type { LocalMap, Osint } from "../src/core/protocol";
import { bearing, metresBetween } from "../src/core/geo";
import { Canvas } from "../src/core/pixels";
import { tiled } from "../src/core/tiles";
import { lensCanvas } from "../src/core/board";
import { renderSkyLens, skyPlanes, type SkyModel } from "../src/sky/render";

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
  it("renders the full screen and leaves the text of the two rows clear", () => {
    const frame = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 1);
    expect(frame).toHaveLength(W * H);
    for (let y = BAND_Y + 4; y < H; y++) for (let x = 20; x < 470; x++) expect(frame[y * W + x]).toBe(0);
  });
  it("lists the most severe incidents first, with distance and bearing", () => {
    const rows = incidentRows(SAMPLE_OSINT);
    expect(rows[0]).toMatchObject({ severity: 3, dist: "440M" });
    expect(rows[0]?.title).toContain("Collision");
    expect(rows[1]).toMatchObject({ severity: 2, dist: "310M" });
    expect(summaryText(SAMPLE_OSINT)).toBe("3 ALERTS  ·  4 AIRCRAFT");
  });
  it("says when Loops is away", () => {
    const away = { ...SAMPLE_OSINT, connected: false, error: "no route to host" };
    expect(messageLines(away)[0]).toContain("not reachable");
    expect(incidentRows(away)).toEqual([]);
  });
  it("names no city it does not know", () => {
    const me = { lat: 35.68, lon: 139.76, heading: null, area: null };
    expect(aroundStatus({ ...SAMPLE_OSINT, me: { ...me, source: "gps" } })).toBe("Here");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: { ...me, source: "home" } })).toBe("Home");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: null })).toBe("No fix");
    expect(aroundStatus({ ...SAMPLE_OSINT, me: { ...me, source: "gps", area: "Harbour Quarter" } })).toBe("Harbour Quarter");
    expect(aroundStatus({ ...SAMPLE_OSINT, connected: false })).toBe("Around");
  });
  it("says when the incident list is unknown, not quiet", () => {
    const osint = { ...SAMPLE_OSINT, items: [], missing: ["items" as const] };
    expect(messageLines(osint)).toEqual(["No incident data for this area."]);
    expect(summaryText(osint)).toContain("? ALERTS");
    expect(messageLines({ ...SAMPLE_OSINT, items: [] })).toEqual(["All quiet nearby."]);
  });
  it("grows the critical ring outwards, 22 m a second from 30 m to 74 m, then starts again", () => {
    expect(pulseRadius(0)).toBe(30);
    expect(pulseRadius(1)).toBe(52);
    expect(pulseRadius(1.99)).toBeGreaterThan(73);
    expect(pulseRadius(2)).toBe(30);
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
        buildings: SAMPLE_MAP.buildings.map((b) => ({ ...b, ring: b.ring.map(p) })),
      } as LocalMap,
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
      expect(sky(osint, t)).toEqual(sky(SAMPLE_OSINT, t));
    }
  });
});

/** The Sky lens for a feed, as the page draws it with live traffic. */
function sky(osint: Osint, t: number): Uint8Array {
  const model: SkyModel = { planes: skyPlanes(osint), selectedId: null, showCount: true, message: null, noPosition: false, clock: "18:16", open: 1, sweeping: true };
  const canvas = lensCanvas();
  renderSkyLens(canvas, model, t);
  return canvas.pixels;
}

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
    expect(feedNotice(SAMPLE_OSINT, "open", null, now + 180)).toBe("No new data for 3 min.");
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
