import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientMessageSchema, MapSchema, OsintSchema, ServerMessageSchema, type LocalMap, type Osint } from "../src/core/protocol";
import { AircraftService, type AircraftProvider } from "../server/open/aircraft";
import { JUMP_M, OpenFeed, type OpenFeedOptions } from "../server/open/feed";
import { inNetherlands, type IncidentProvider, type Item } from "../server/open/incidents";
import { parseOverpass, type MapProvider, type Tile } from "../server/open/map";
import { buildOpenFeed, chooseFeed } from "../server/open/select";
import { fakeFetch, fixture, gz, json, ok } from "./openkit";

const AMS = { lat: 52.3791, lon: 4.9003 };
/** About `m` metres north. */
const north = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 110_540, lon: p.lon });

const plane = { id: "484c53", callsign: "KLM930", lat: 52.4, lon: 4.8, altitude_ft: 3200, track: 240, speed_kt: 246, emergency: false };
const item: Item = { id: "ndw:1", kind: "roadworks", severity: 2, title: "Road closed for roadworks", lat: AMS.lat + 0.005, lon: AMS.lon, area: null, lines: [] };
const tile: Tile = { roads: [{ class: "major", points: [[AMS.lat, AMS.lon], [AMS.lat + 0.001, AMS.lon]] }], water: [], green: [], buildings: [], area: "Centrum", fetchedAt: 0 };

function rig(over: Partial<OpenFeedOptions> = {}) {
  const fetchAircraft = vi.fn(async () => [plane]);
  const provider: AircraftProvider = { name: "stub", minIntervalMs: 5000, fetchAircraft };
  const tileFor = vi.fn(async (_at: { lat: number; lon: number }) => ({ tile, fresh: true }));
  const load = vi.fn(async () => [item]);
  const incidents: IncidentProvider = { name: "stub", minIntervalMs: 300_000, covers: inNetherlands, load };
  const updates: Osint[] = [];
  const maps: LocalMap[] = [];
  const feed = new OpenFeed(
    { aircraft: new AircraftService([provider]), map: { tileFor, retryDue: () => false } as unknown as MapProvider, incidents, active: () => true, ...over },
    (o) => updates.push(o),
    (m) => maps.push(m),
  );
  return { feed, fetchAircraft, tileFor, load, updates, maps };
}
/** The log without its timestamps: "22:22:04.923" holds "4.9", which looks like a coordinate. */
const withoutTimestamps = (lines: string[]): string => lines.map((l) => l.replace(/^\S+Z /, "")).join("");
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("position handling", () => {
  it("with no position it sends 'no fix' (me null), asks nobody for anything, and is not marked as missing data", async () => {
    const { feed, fetchAircraft, tileFor, load } = rig({ tickMs: 5 });
    feed.start();
    await settle();
    feed.stop();
    expect(feed.latest).toMatchObject({ connected: true, error: null, me: null, items: [], aircraft: [], vehicles: [] });
    expect(feed.latest.missing).toBeUndefined();
    expect(OsintSchema.safeParse(feed.latest).success).toBe(true);
    expect([fetchAircraft, tileFor, load].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("uses HUD_LAT and HUD_LON as the home position until an app sends one", () => {
    const { feed } = rig({ home: AMS });
    expect(feed.latest.me).toMatchObject({ lat: AMS.lat, lon: AMS.lon, source: "home" });
    feed.setPosition({ lat: 52.5, lon: 5, accuracy: 20 });
    expect(feed.latest.me).toMatchObject({ lat: 52.5, source: "gps" });
  });

  it("ignores a jump under 25 m and accepts one over it", async () => {
    const { feed, updates } = rig();
    feed.setPosition(AMS);
    await settle();
    const before = updates.length;
    feed.setPosition(north(AMS, JUMP_M - 5));
    feed.setPosition(north(AMS, 10));
    await settle();
    expect(updates.length).toBe(before);
    expect(feed.latest.me).toMatchObject({ lat: AMS.lat, lon: AMS.lon });
    feed.setPosition(north(AMS, JUMP_M + 5));
    expect(feed.latest.me!.lat).toBeCloseTo(north(AMS, JUMP_M + 5).lat, 6);
  });

  it("ignores a very coarse fix once there is a good one, and invalid numbers", () => {
    const { feed } = rig();
    feed.setPosition({ ...AMS, accuracy: 30 });
    feed.setPosition({ lat: 10, lon: 10, accuracy: 50_000 });
    feed.setPosition({ lat: 95, lon: 10 });
    feed.setPosition({ lat: Number.NaN, lon: 10 });
    expect(feed.latest.me).toMatchObject({ lat: AMS.lat, lon: AMS.lon });
  });

  it("fetches the map once for a small move inside the tile, and again after a large move to another tile", async () => {
    const { feed, tileFor, maps } = rig();
    const start = { lat: 52.3752, lon: 4.9003 };
    feed.setPosition(start);
    await vi.waitFor(() => expect(maps).toHaveLength(1));
    expect(tileFor).toHaveBeenCalledTimes(1);
    feed.setPosition(north(start, 100));
    await settle();
    expect(tileFor).toHaveBeenCalledTimes(1);
    expect(maps).toHaveLength(1);
    const far = north(start, 3000);
    feed.setPosition(far);
    await vi.waitFor(() => expect(tileFor).toHaveBeenCalledTimes(2));
    expect(tileFor.mock.calls[1]![0]).toMatchObject({ lat: far.lat });
    await vi.waitFor(() => expect(maps).toHaveLength(2));
    expect(maps[1]!.center.lat).toBeCloseTo(far.lat, 6);
  });

  it("sends the map again after a move of 300 m or more in the same tile", async () => {
    const { feed, maps } = rig();
    feed.setPosition({ lat: 52.3752, lon: 4.9003 });
    await vi.waitFor(() => expect(maps).toHaveLength(1));
    feed.setPosition({ lat: 52.3752 + 0.0035, lon: 4.9003 });
    await vi.waitFor(() => expect(maps).toHaveLength(2));
  });
});

describe("what the feed asks for", () => {
  it("asks for nothing while no Around or Sky page is connected", async () => {
    const { feed, fetchAircraft, tileFor, load } = rig({ active: () => false });
    feed.setPosition(AMS);
    await settle();
    expect([fetchAircraft, tileFor, load].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("fills in aircraft with trails, incidents, and the area name", async () => {
    const { feed, updates } = rig();
    feed.setPosition(AMS);
    await vi.waitFor(() => expect(feed.latest.aircraft).toHaveLength(1));
    await vi.waitFor(() => expect(feed.latest.items).toHaveLength(1));
    await vi.waitFor(() => expect(feed.latest.me?.area).toBe("Centrum"));
    expect(feed.latest.aircraft[0]).toMatchObject({ id: "484c53", callsign: "KLM930", trail: [] });
    expect(feed.latest.missing).toBeUndefined();
    expect(updates.every((o) => OsintSchema.safeParse(o).success)).toBe(true);
  });

  it("sends aircraft, incidents and position at once while the map is still loading, and no map until it arrives", async () => {
    let arrive: (v: { tile: Tile; fresh: boolean }) => void = () => undefined;
    const slow = { tileFor: vi.fn(() => new Promise<{ tile: Tile; fresh: boolean }>((r) => (arrive = r))), retryDue: () => false } as unknown as MapProvider;
    const { feed, maps, updates } = rig({ map: slow });
    feed.setPosition(AMS);
    await vi.waitFor(() => expect(feed.latest.aircraft).toHaveLength(1));
    await vi.waitFor(() => expect(feed.latest.items).toHaveLength(1));
    expect(feed.latest.me).toMatchObject({ source: "gps", area: null });
    expect(updates.length).toBeGreaterThan(0);
    expect(maps).toHaveLength(0);
    expect(feed.latestMap()).toBeNull();
    arrive({ tile, fresh: true });
    await vi.waitFor(() => expect(maps).toHaveLength(1));
    expect(feed.latest.me?.area).toBe("Centrum");
  });

  it("says which provider answered in aircraftSource, and not before any answer", async () => {
    const { feed } = rig();
    feed.setPosition(AMS);
    expect(feed.latest.aircraftSource).toBeUndefined();
    await vi.waitFor(() => expect(feed.latest.aircraftSource).toBe("stub"));
    expect(OsintSchema.safeParse(feed.latest).success).toBe(true);
    const off = rig({ aircraft: new AircraftService([]) });
    off.feed.setPosition(AMS);
    expect(off.feed.latest.aircraftSource).toBeUndefined();
  });

  it("puts the nearest named street in the incident title, and logs that incidents loaded, without coordinates", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
    const street: Tile = { ...tile, named: true, roads: [{ class: "street", name: "Prins Hendrikkade", points: [[AMS.lat + 0.005, AMS.lon - 0.0003], [AMS.lat + 0.005, AMS.lon + 0.0003]] }] };
    const { feed } = rig({ map: { tileFor: async () => ({ tile: street, fresh: true }), retryDue: () => false } as unknown as MapProvider });
    feed.setPosition(AMS);
    await vi.waitFor(() => expect(feed.latest.items[0]?.title).toBe("Road closed · Prins Hendrikkade"));
    spy.mockRestore();
    const log = withoutTimestamps(lines);
    expect(log).toMatch(/INFO incidents loaded \{"source":"stub","count":1\}/);
    expect(log).not.toMatch(/52\.3|4\.9/);
  });

  describe("the street title when the incidents and the map tile arrive in either order", () => {
    const street: Tile = { ...tile, named: true, roads: [{ class: "street", name: "Prins Hendrikkade", points: [[AMS.lat + 0.005, AMS.lon - 0.0003], [AMS.lat + 0.005, AMS.lon + 0.0003]] }] };
    const defer = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    };

    async function run(order: "tile first" | "incidents first") {
      const tileGate = defer<{ tile: Tile; fresh: boolean }>();
      const itemGate = defer<Item[]>();
      const map = { tileFor: () => tileGate.promise, retryDue: () => false } as unknown as MapProvider;
      const incidents: IncidentProvider = { name: "stub", minIntervalMs: 300_000, covers: inNetherlands, load: () => itemGate.promise };
      const { feed, updates } = rig({ map, incidents });
      feed.setPosition(AMS);
      const tileDone = () => tileGate.resolve({ tile: street, fresh: true });
      const itemsDone = () => itemGate.resolve([item]);
      const titles = () => updates.flatMap((o) => o.items.map((i) => i.title));
      if (order === "tile first") {
        tileDone();
        await vi.waitFor(() => expect(feed.latest.me?.area).toBe("Centrum"));
        expect(titles()).toEqual([]);
        itemsDone();
      } else {
        itemsDone();
        await vi.waitFor(() => expect(titles()).toContain("Road closed for roadworks"));
        tileDone();
      }
      await vi.waitFor(() => expect(updates.at(-1)!.items[0]?.title).toBe("Road closed · Prins Hendrikkade"));
      return { updates, feed };
    }

    it("tile first: the title has the street the moment the incident arrives", async () => {
      const { updates } = await run("tile first");
      expect(updates.flatMap((o) => o.items.map((i) => i.title))).toEqual(["Road closed · Prins Hendrikkade"]);
    });

    it("incidents first: the plain title is sent, then an updated osint with the street when the tile arrives", async () => {
      const { updates, feed } = await run("incidents first");
      const titles = updates.flatMap((o) => o.items.map((i) => i.title));
      expect(titles[0]).toBe("Road closed for roadworks");
      expect(titles.at(-1)).toBe("Road closed · Prins Hendrikkade");
      expect(feed.latest.items[0]!.title).toBe("Road closed · Prins Hendrikkade");
    });
  });

  it("keeps the plain title for a tile cached without names", async () => {
    const { feed } = rig({ map: { tileFor: async () => ({ tile: { ...tile, named: false }, fresh: false }), retryDue: () => false } as unknown as MapProvider });
    feed.setPosition(AMS);
    await vi.waitFor(() => expect(feed.latest.items).toHaveLength(1));
    expect(feed.latest.items[0]!.title).toBe("Road closed for roadworks");
  });

  it("outside the Netherlands the incident list says 'no data source' (missing: items) and NDW is not asked", async () => {
    const { feed, load, fetchAircraft } = rig();
    feed.setPosition({ lat: 48.8566, lon: 2.3522 });
    await vi.waitFor(() => expect(fetchAircraft).toHaveBeenCalled());
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(feed.latest.items).toEqual([]);
    expect(feed.latest.missing).toContain("items");
  });

  it("marks aircraft as missing when the source is off or has not answered", () => {
    const { feed } = rig({ aircraft: new AircraftService([]) });
    feed.setPosition(AMS);
    expect(feed.latest.missing).toContain("aircraft");
  });

  it("does not write coordinates to the log", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
    const { feed } = rig();
    feed.setPosition({ lat: 52.123456, lon: 4.654321, accuracy: 20 });
    await settle();
    spy.mockRestore();
    expect(withoutTimestamps(lines)).not.toMatch(/52\.12|4\.65/);
  });
});

describe("end to end: a position message, fake HTTP, valid osint and osint_map", () => {
  let dir: string;
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "g2-open-"))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const net = () =>
    fakeFetch((url) => {
      if (url.includes("adsb.fi")) return ok(json("adsbfi.json"));
      if (url.includes("overpass")) return ok(json("overpass.json"));
      // The recorded accident is moved next to the test position so the radius filter keeps it.
      if (url.includes("ndw.nu")) return gz(fixture("ndw.xml").replace("51.53806", "52.3795").replace("5.047521", "4.9010"));
      throw new Error(`unexpected request to ${url}`);
    });

  async function run(position: { lat: number; lon: number }, env: Record<string, string> = {}) {
    const f = net();
    const messages: unknown[] = [];
    const choice = chooseFeed(env, {
      loops: () => {
        throw new Error("not used");
      },
      open: () =>
        buildOpenFeed(
          env,
          { active: () => true, onUpdate: (data) => messages.push({ type: "osint", data }), onMap: (data) => messages.push({ type: "osint_map", data }) },
          f,
          dir,
          5,
        ),
    });
    choice.feed!.start();
    // The message goes through the same schema the server uses.
    const parsed = ClientMessageSchema.parse({ type: "position", ...position, accuracy: 15 });
    if (parsed.type === "position") choice.position(parsed);
    await vi.waitFor(
      () => {
        const last = [...messages].reverse().find((m: any) => m.type === "osint") as any;
        expect(messages.some((m: any) => m.type === "osint_map")).toBe(true);
        expect(last.data.aircraft.length).toBeGreaterThan(0);
        expect(last.data.missing ?? []).toEqual([]);
      },
      { timeout: 4000 },
    );
    choice.feed!.stop();
    return { messages, f };
  }

  it("in the Netherlands: aircraft, map, area and an incident, all valid", async () => {
    const { messages, f } = await run(AMS);
    for (const m of messages) expect(ServerMessageSchema.safeParse(m).success).toBe(true);
    const osint = [...messages].reverse().find((m: any) => m.type === "osint") as { data: Osint };
    const map = messages.find((m: any) => m.type === "osint_map") as { data: LocalMap };
    expect(OsintSchema.safeParse(osint.data).success).toBe(true);
    expect(MapSchema.safeParse(map.data).success).toBe(true);
    expect(osint.data.me).toMatchObject({ source: "gps", heading: null });
    expect(osint.data.me!.area).toMatch(/\S/);
    expect(osint.data.items.map((i) => i.title)).toEqual(["Accident"]);
    expect(map.data.roads.length).toBeGreaterThan(0);
    // One request to each service, with the descriptive User-Agent and no coordinates of the user in a header.
    expect(f.calls.map((c) => new URL(c.url).host).sort()).toEqual(["opendata.adsb.fi", "opendata.ndw.nu", "overpass-api.de"]);
    expect(f.calls.every((c) => c.headers["User-Agent"] === "g2-hud (open source)")).toBe(true);
  });

  it("outside the Netherlands: no request goes to NDW, and items are marked missing", async () => {
    const f = net();
    const messages: any[] = [];
    const feed = buildOpenFeed({}, { active: () => true, onUpdate: (d) => messages.push(d), onMap: () => undefined }, f, dir, 5);
    feed.start();
    feed.setPosition({ lat: 48.8566, lon: 2.3522 });
    await vi.waitFor(() => expect(messages.some((o) => o.aircraft.length > 0)).toBe(true), { timeout: 4000 });
    feed.stop();
    expect(f.calls.some((c) => c.url.includes("ndw.nu"))).toBe(false);
    expect(messages.at(-1).missing).toEqual(["items"]);
  });

  it("parses the fixture for the e2e case", () => {
    expect(parseOverpass(json("overpass.json"), 0).roads.length).toBeGreaterThan(0);
  });
});
