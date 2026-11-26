import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapSchema } from "../src/core/protocol";
import { textWidth } from "../src/core/text";
import { CACHE_TTL_MS, MAX_BUILDINGS, POINT_BUDGET, streetNear, titleWithStreet, MapProvider, TileCache, buildQuery, cutMap, fitRing, parseOverpass, stitch, tileKey, type Tile } from "../server/open/map";
import type { LL } from "../server/open/geo";
import { fakeFetch, json, ok, status } from "./openkit";

const C = { lat: 52.3791, lon: 4.9003 };
const at = (dx: number, dy: number): LL => [C.lat + dy / 110_540, C.lon + dx / (111_320 * Math.cos((C.lat * Math.PI) / 180))];
const square = (x: number, y: number, size = 20): LL[] => [at(x, y), at(x + size, y), at(x + size, y + size), at(x, y + size), at(x, y)];
const geom = (ring: LL[]) => ring.map(([lat, lon]) => ({ lat, lon }));
const way = (tags: Record<string, string>, ring: LL[]) => ({ type: "way", id: 1, tags, geometry: geom(ring) });
const emptyTile = (over: Partial<Tile> = {}): Tile => ({ roads: [], water: [], green: [], buildings: [], area: null, fetchedAt: 0, ...over });

describe("parseOverpass", () => {
  it("reads the recorded answer: classes, water, and the area name", () => {
    const tile = parseOverpass(json("overpass.json"), 1000);
    expect(tile.area).toMatch(/\S/);
    const classes = new Set(tile.roads.map((r) => r.class));
    expect(classes).toEqual(new Set(["major", "street"]));
    expect(tile.water.length).toBe(2);
    expect(tile.water.every((ring) => ring.length >= 4 && ring[0]![0] === ring.at(-1)![0])).toBe(true);
    expect(tile.fetchedAt).toBe(1000);
  });

  it("classes roads: major, street, minor, path and rail", () => {
    const line = [at(0, 0), at(50, 0)];
    const g = (tags: Record<string, string>) => ({ type: "way", id: 1, tags, geometry: geom(line) });
    const tile = parseOverpass({
      elements: [g({ highway: "motorway_link" }), g({ highway: "primary" }), g({ highway: "tertiary" }), g({ highway: "residential" }), g({ highway: "cycleway" }), g({ railway: "rail" }), g({ highway: "service" })],
    }, 0);
    expect(tile.roads.map((r) => r.class)).toEqual(["major", "major", "street", "minor", "path", "rail"]);
  });

  it("takes the smallest enclosing place for the area name", () => {
    const area = (place: string, name: string) => ({ type: "area", id: 1, tags: { place, name } });
    expect(parseOverpass({ elements: [area("city", "Amsterdam"), area("suburb", "Centrum"), area("quarter", "Jordaan")] }, 0).area).toBe("Jordaan");
    expect(parseOverpass({ elements: [area("city", "Amsterdam"), { type: "area", id: 2, tags: { place: "island", name: "X" } }] }, 0).area).toBe("Amsterdam");
    expect(parseOverpass({ elements: [] }, 0).area).toBeNull();
  });

  it("drops bad elements one by one and counts them", () => {
    const report = { dropped: 0 };
    const tile = parseOverpass({ elements: [way({ highway: "primary" }, [at(0, 0), at(20, 0)]), 5, { type: 7 }, { type: "way", tags: { highway: 1 } }] }, 0, report);
    expect(tile.roads).toHaveLength(1);
    expect(report.dropped).toBe(3);
  });

  it("throws when the answer is not an Overpass answer", () => {
    expect(() => parseOverpass({ remark: "runtime error: Query timed out" }, 0)).toThrow();
  });

  it("closes water from a multipolygon relation by joining its outer ways, and ignores open rings", () => {
    const a = [at(0, 0), at(100, 0), at(100, 100)];
    const b = [at(100, 100), at(0, 100), at(0, 0)];
    const lone = [at(500, 500), at(600, 500)];
    expect(stitch([a, b, lone])).toHaveLength(1);
    const tile = parseOverpass({
      elements: [
        { type: "relation", id: 9, tags: { natural: "water", type: "multipolygon" }, members: [{ type: "way", role: "outer", geometry: geom(a) }, { type: "way", role: "outer", geometry: geom(b.reverse()) }, { type: "way", role: "inner", geometry: geom(square(10, 10)) }] },
      ],
    }, 0);
    expect(tile.water).toHaveLength(1);
  });

  it("drops specks of water and grass and keeps the larger shapes", () => {
    const tile = parseOverpass({ elements: [way({ natural: "water" }, square(0, 0, 8)), way({ natural: "water" }, square(0, 0, 80)), way({ leisure: "park" }, square(0, 0, 200)), way({ landuse: "grass" }, square(0, 0, 5))] }, 0);
    expect(tile.water).toHaveLength(1);
    expect(tile.green).toHaveLength(1);
  });

  it("keeps a building with its height from the height tag, the level count, or a default", () => {
    const tile = parseOverpass({
      elements: [way({ building: "yes", height: "24 m" }, square(0, 0)), way({ building: "yes", "building:levels": "5" }, square(50, 0)), way({ building: "yes" }, square(100, 0)), way({ building: "yes", height: "900" }, square(150, 0))],
    }, 0);
    expect(tile.buildings.map((b) => b.height)).toEqual([24, 16, 9, 150]);
  });

  it("fits a long outline to 13 points and skips an open one", () => {
    const circle: LL[] = Array.from({ length: 41 }, (_, i) => at(Math.cos((i / 40) * 2 * Math.PI) * 30, Math.sin((i / 40) * 2 * Math.PI) * 30));
    circle[40] = circle[0]!;
    const fitted = fitRing(circle)!;
    expect(fitted.length).toBeLessThanOrEqual(13);
    expect(fitted.length).toBeGreaterThanOrEqual(4);
    expect(fitted[0]).toEqual(fitted.at(-1));
    expect(fitRing([at(0, 0), at(10, 0), at(10, 10), at(0, 10)])).toBeNull();
  });
});

describe("cutMap and the building limits", () => {
  const tileWith = (buildings: Tile["buildings"]) => emptyTile({ buildings });

  it("keeps at most 80 buildings, the nearest ones", () => {
    const buildings = Array.from({ length: 200 }, (_, i) => ({ ring: square(i * 4 - 400, 100 + (i % 7) * 5), height: 10 }));
    const map = cutMap(tileWith(buildings), C);
    expect(map.buildings).toHaveLength(MAX_BUILDINGS);
    const metres = (b: { ring: LL[] }) => Math.min(...b.ring.map((p) => Math.hypot((p[1] - C.lon) * 111_320 * Math.cos((C.lat * Math.PI) / 180), (p[0] - C.lat) * 110_540)));
    const far = Math.max(...map.buildings!.map(metres));
    const kept = new Set(map.buildings!.map((b) => b.ring));
    expect(buildings.filter((b) => !kept.has(b.ring)).every((b) => metres(b) >= far - 20)).toBe(true);
    expect(MapSchema.safeParse(map).success).toBe(true);
  });

  it("leaves out buildings farther than 1,000 m, with a point beyond 1,200 m, or a span over 400 m", () => {
    const map = cutMap(tileWith([
      { ring: square(0, 50), height: 10 },
      { ring: square(1050, 0), height: 10 },
      { ring: square(950, 0, 300), height: 10 },
      { ring: square(0, 0, 450), height: 10 },
      { ring: square(-980, 0, 15), height: 10 },
    ]), C);
    expect(map.buildings).toHaveLength(2);
  });

  it("leaves buildings out (not empty) when none qualify, and centres the map on you", () => {
    const map = cutMap(tileWith([{ ring: square(3000, 0), height: 10 }]), C);
    expect("buildings" in map).toBe(false);
    expect(map.center).toEqual(C);
  });

  it("clips roads and areas to the square round you", () => {
    const tile = emptyTile({
      roads: [{ class: "major", points: [at(0, 0), at(100, 0)] }, { class: "major", points: [at(5000, 0), at(5100, 0)] }],
      water: [square(4000, 4000, 100), square(0, 0, 100)],
    });
    const map = cutMap(tile, C);
    expect(map.roads).toHaveLength(1);
    expect(map.water).toHaveLength(1);
  });
});

describe("cutMap: what one position gets", () => {
  const road = (cls: string, a: LL, b: LL) => ({ class: cls, points: [a, b] });
  const east = (n: number, y = 100) => road("minor", at(n, y), at(n + 60, y));

  it("drops a far road and a road behind the view, keeps a near one", () => {
    const map = cutMap(emptyTile({ roads: [road("major", at(0, 100), at(0, 200)), road("major", at(3000, 100), at(3000, 200)), road("major", at(0, 2500), at(0, 2600)), road("major", at(0, -900), at(0, -700))] }), C);
    expect(map.roads).toHaveLength(1);
  });

  it("clips a long road to the view instead of dropping it", () => {
    const map = cutMap(emptyTile({ roads: [road("major", at(-8000, 300), at(8000, 300)), road("street", at(0, -3000), at(0, 9000))] }), C);
    expect(map.roads).toHaveLength(2);
    const lons = map.roads[0]!.points.map((p) => p[1]);
    const metresEast = (lon: number) => (lon - C.lon) * 111_320 * Math.cos((C.lat * Math.PI) / 180);
    expect(Math.min(...lons.map(metresEast))).toBeGreaterThanOrEqual(-1501);
    expect(Math.max(...lons.map(metresEast))).toBeLessThanOrEqual(1501);
    const north = map.roads[1]!.points.map((p) => (p[0] - C.lat) * 110_540);
    expect(Math.max(...north)).toBeLessThanOrEqual(1901);
    expect(Math.min(...north)).toBeGreaterThanOrEqual(-451);
  });

  it("cuts a long road that leaves the view and comes back into two pieces", () => {
    const loop = { class: "street", points: [at(-100, 100), at(-100, 3000), at(100, 3000), at(100, 100)] as LL[] };
    expect(cutMap(emptyTile({ roads: [loop] }), C).roads).toHaveLength(2);
  });

  it("sends the more important classes first, and the nearest first within a class", () => {
    const tile = emptyTile({ roads: [road("path", at(0, 50), at(60, 50)), east(100, 400), east(100, 200), road("street", at(0, 900), at(60, 900)), road("major", at(0, 1400), at(60, 1400)), road("rail", at(0, 700), at(60, 700))] });
    const map = cutMap(tile, C);
    expect(map.roads.map((r) => r.class)).toEqual(["major", "street", "rail", "minor", "minor", "path"]);
    expect(map.roads[3]!.points[0]![0]).toBeLessThan(map.roads[4]!.points[0]![0]);
  });

  it("caps each class and keeps the nearest", () => {
    const tile = emptyTile({ roads: Array.from({ length: 400 }, (_, i) => road("street", at(0, 50 + i * 4), at(60, 50 + i * 4))) });
    const map = cutMap(tile, C);
    expect(map.roads).toHaveLength(120);
    const lat = (r: { points: LL[] }) => r.points[0]![0];
    expect(Math.max(...map.roads.map(lat))).toBeLessThan(at(0, 50 + 125 * 4)[0]);
  });

  it("stays inside the point budget and puts major roads before minor ones when it is full", () => {
    const wiggle = (cls: string, y: number) => ({ class: cls, points: Array.from({ length: 60 }, (_, i) => at(i * 12, y + (i % 2) * 40)) });
    const tile = emptyTile({ roads: [...Array.from({ length: 60 }, (_, i) => wiggle("minor", 60 + i * 20)), wiggle("major", 900)] });
    const map = cutMap(tile, C);
    const points = map.roads.reduce((n, r) => n + r.points.length, 0);
    expect(points).toBeLessThanOrEqual(POINT_BUDGET);
    expect(map.roads[0]!.class).toBe("major");
  });

  it("leaves out minor roads beyond 1,300 m, paths beyond 700 m and stubs under 30 m", () => {
    const map = cutMap(emptyTile({ roads: [road("minor", at(0, 1500), at(60, 1500)), road("path", at(0, 800), at(60, 800)), road("path", at(0, 100), at(10, 100)), road("minor", at(0, 1200), at(60, 1200))] }), C);
    expect(map.roads.map((r) => r.class)).toEqual(["minor"]);
  });

  it("simplifies finer near you than far away, and drops specks of water and parks", () => {
    const bumpy = (y: number) => ({ class: "street", points: Array.from({ length: 41 }, (_, i) => at(i * 10, y + (i % 2) * 1.6)) });
    const map = cutMap(emptyTile({ roads: [bumpy(60), bumpy(1500)], water: [square(0, 100, 20), square(0, 300, 200)] }), C);
    const [near, far] = map.roads;
    expect(near!.points.length).toBeGreaterThan(far!.points.length);
    expect(map.water).toHaveLength(1);
  });

  it("keeps the whole message for a dense city under 60 KB", () => {
    const tile = emptyTile({
      roads: Array.from({ length: 6000 }, (_, i) => ({ class: ["major", "street", "minor", "path"][i % 4]!, points: Array.from({ length: 12 }, (_, k): LL => at(((i * 37) % 3000) - 1500 + k * 8, ((i * 53) % 2400) - 450 + (k % 2) * 6)) })),
      water: Array.from({ length: 100 }, (_, i) => square(((i * 71) % 2800) - 1400, (i * 17) % 1800, 60)),
      buildings: Array.from({ length: 500 }, (_, i) => ({ ring: square(((i * 13) % 1600) - 800, (i * 29) % 900, 18), height: 12 })),
    });
    const map = cutMap(tile, C);
    expect(JSON.stringify(map).length).toBeLessThan(62_000);
    expect(MapSchema.safeParse(map).success).toBe(true);
  });
});

describe("tiles and the query", () => {
  it("gives the same key for nearby points and another across a tile edge", () => {
    expect(tileKey(52.3791, 4.9003)).toBe(tileKey(52.3792, 4.9004));
    expect(tileKey(52.3791, 4.9003)).not.toBe(tileKey(52.3991, 4.9003));
  });

  it("asks for roads, rail, water, parks, buildings and the area in one query", () => {
    const q = buildQuery(C);
    for (const part of ["is_in(", 'place~"^(neighbourhood|quarter|suburb|village|town|city)$"', '"highway"', '"railway"="rail"', '"natural"="water"', '"leisure"', '"building"', "out geom"]) expect(q).toContain(part);
  });
});

describe("TileCache on disk", () => {
  let dir: string;
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "g2-open-"))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes and reads a tile back", async () => {
    const cache = new TileCache(join(dir, "nested"));
    const tile = parseOverpass(json("overpass.json"), 5);
    await cache.write("1_2", tile);
    expect(await cache.read("1_2")).toEqual(tile);
    expect(await cache.read("9_9")).toBeNull();
    expect((await readdir(join(dir, "nested"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("ignores a damaged file", async () => {
    await writeFile(join(dir, "map-1_2.json"), "{not json");
    expect(await new TileCache(dir).read("1_2")).toBeNull();
    await writeFile(join(dir, "map-1_3.json"), JSON.stringify({ version: 1, tile: { roads: "x" } }));
    expect(await new TileCache(dir).read("1_3")).toBeNull();
  });
});

describe("MapProvider: cache, expiry, backoff and one request at a time", () => {
  let dir: string;
  let clock: number;
  const T0 = Date.parse("2026-11-25T12:00:00Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "g2-open-"));
    clock = T0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const provider = (f: ReturnType<typeof fakeFetch>, url?: string) => new MapProvider({ fetch: f, cache: new TileCache(dir), url, now: () => clock });

  it("fetches once, then serves from memory and from disk (a new provider) without a request", async () => {
    const f = fakeFetch(() => ok(json("overpass.json")));
    const p = provider(f);
    const first = await p.tileFor(C);
    expect(first?.fresh).toBe(true);
    await p.tileFor(C);
    await provider(f).tileFor({ lat: C.lat - 0.0005, lon: C.lon });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://overpass-api.de/api/interpreter");
    expect(call.method).toBe("POST");
    expect(call.headers["User-Agent"]).toBe("g2-hud (open source)");
    expect(new URLSearchParams(call.body).get("data")).toContain("[out:json]");
  });

  it("uses OVERPASS_URL when given", async () => {
    const f = fakeFetch(() => ok(json("overpass.json")));
    await provider(f, "https://overpass.example/api/interpreter").tileFor(C);
    expect(f.calls[0]!.url).toBe("https://overpass.example/api/interpreter");
  });

  it("asks again after 7 days, not before", async () => {
    const f = fakeFetch(() => ok(json("overpass.json")));
    const p = provider(f);
    await p.tileFor(C);
    clock += CACHE_TTL_MS - 1000;
    await p.tileFor(C);
    expect(f.calls).toHaveLength(1);
    clock += 2000;
    await p.tileFor(C);
    expect(f.calls).toHaveLength(2);
  });

  it("serves the stale map when the refresh fails, and backs off", async () => {
    let fail = false;
    const f = fakeFetch(() => (fail ? status(504) : ok(json("overpass.json"))));
    const p = provider(f);
    await p.tileFor(C);
    clock += CACHE_TTL_MS + 1;
    fail = true;
    const got = await p.tileFor(C);
    expect(got?.fresh).toBe(false);
    expect(got?.tile.roads.length).toBeGreaterThan(0);
    expect(p.retryDue()).toBe(false);
    expect(f.calls).toHaveLength(2);
    await p.tileFor(C); // still backing off: no request
    expect(f.calls).toHaveLength(2);
    clock += 60_000;
    expect(p.retryDue()).toBe(true);
  });

  it("gives null with no cache and a failing server, and obeys Retry-After on a 429", async () => {
    const f = fakeFetch(() => status(429, { "Retry-After": "120" }));
    const p = provider(f);
    expect(await p.tileFor(C)).toBeNull();
    clock += 119_000;
    expect(p.retryDue()).toBe(false);
    clock += 1000;
    expect(p.retryDue()).toBe(true);
  });

  it("backs off longer after each failure", async () => {
    const f = fakeFetch(() => status(504));
    const p = provider(f);
    await p.tileFor(C);
    clock += 20_000;
    expect(p.retryDue()).toBe(true);
    await p.tileFor(C);
    clock += 39_000;
    expect(p.retryDue()).toBe(false);
    clock += 1000;
    expect(p.retryDue()).toBe(true);
  });

  it("never sends two requests at the same time", async () => {
    let release: (r: Response) => void = () => undefined;
    const f = fakeFetch(() => new Promise<Response>((r) => (release = r)));
    const p = provider(f);
    const a = p.tileFor(C);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const b = await p.tileFor({ lat: C.lat + 0.05, lon: C.lon });
    expect(b).toBeNull();
    expect(f.calls).toHaveLength(1);
    release(ok(json("overpass.json")));
    expect((await a)?.fresh).toBe(true);
  });

  it("treats an answer that is not Overpass JSON as a failure", async () => {
    const f = fakeFetch(() => ok("<html>busy</html>"));
    expect(await provider(f).tileFor(C)).toBeNull();
  });
});

describe("street names", () => {
  const named = (name: string | undefined, a: LL, b: LL) => ({ class: "street", ...(name ? { name } : {}), points: [a, b] });

  it("keeps the name tag in the tile and leaves it out of the map sent to the app", () => {
    const tile = parseOverpass({ elements: [{ type: "way", id: 1, tags: { highway: "primary", name: "Prins Hendrikkade" }, geometry: geom([at(0, 100), at(0, 300)]) }, { type: "way", id: 2, tags: { highway: "footway", name: "Kade" }, geometry: geom([at(5, 100), at(5, 300)]) }] }, 0);
    expect(tile.roads.map((r) => r.name)).toEqual(["Prins Hendrikkade", undefined]);
    expect(tile.named).toBe(true);
    expect(JSON.stringify(cutMap(tile, C))).not.toContain("Hendrikkade");
  });

  it("finds the nearest named road within 40 m, and none farther", () => {
    const tile = emptyTile({ roads: [named("Far", at(30, 0), at(30, 400)), named("Near", at(15, 0), at(15, 400)), named(undefined, at(1, 0), at(1, 400))] });
    const [lat, lon] = at(0, 200);
    expect(streetNear(tile, { lat, lon })).toBe("Near");
    const [lat2, lon2] = at(-60, 200);
    expect(streetNear(tile, { lat: lat2, lon: lon2 })).toBeNull();
  });

  it("builds 'Kind · Street' and cuts a long street at a word with an ellipsis", () => {
    expect(titleWithStreet("Road closed", "Prinsengracht", textWidth)).toBe("Road closed · Prinsengracht");
    expect(titleWithStreet("Road closed", null, textWidth)).toBe("Road closed");
    const long = titleWithStreet("Road closed for roadworks", "Professor Doktor Burgemeester van der Heijden Weg Noord Oostzijde Parallelweg", textWidth);
    expect(long.endsWith("…")).toBe(true);
    expect(textWidth(long)).toBeLessThanOrEqual(400);
    expect(long.startsWith("Road closed · Professor")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    // One word too wide for any room: the plain kind.
    expect(titleWithStreet("Road closed for roadworks", "Donaudampfschifffahrtsgesellschaftskapitänsmützenfabrikationsstraße", textWidth)).toBe("Road closed");
  });

  it("a tile cached before names (version 1) is fetched again once, and kept if that fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2-open-"));
    try {
      const tile = parseOverpass(json("overpass.json"), Date.parse("2026-11-25T12:00:00Z"));
      const key = tileKey(C.lat, C.lon);
      await writeFile(join(dir, `map-${key}.json`), JSON.stringify({ version: 1, tile }));
      const cache = new TileCache(dir);
      expect((await cache.read(key))?.named).toBe(false);
      let fail = true;
      const f = fakeFetch(() => (fail ? status(504) : ok(json("overpass.json"))));
      const p = new MapProvider({ fetch: f, cache, now: () => Date.parse("2026-11-25T13:00:00Z") });
      const stale = await p.tileFor(C);
      expect(stale).toMatchObject({ fresh: false });
      expect(f.calls).toHaveLength(1);
      fail = false;
      const p2 = new MapProvider({ fetch: f, cache, now: () => Date.parse("2026-11-25T13:00:00Z") });
      expect((await p2.tileFor(C))?.tile.named).toBe(true);
      expect((await cache.read(key))?.named).toBe(true);
      await p2.tileFor(C);
      expect(f.calls).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
