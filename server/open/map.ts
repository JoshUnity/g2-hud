import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { metresBetween } from "../../src/core/geo";
import type { LocalMap } from "../../src/core/protocol";
import { log } from "../log";
import { HttpError, readText, send, type Fetch } from "./http";
import { areaM2, clipLine, clipRing, frame, lengthM, nearestOnPath, round5, simplify, type LL, type Rect } from "./geo";
import { Pacer } from "./pacer";

/**
 * The map from OpenStreetMap through Overpass. One request per tile; the tile is cached on disk for 7 days.
 * The same limits as the Loops path apply when the map is cut for a position.
 */

export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const CACHE_TTL_MS = 7 * 24 * 3_600_000;

/** A tile is 0.01 degrees of latitude by 0.015 of longitude (about 1.1 x 1 km at 52 N). */
const TILE_LAT = 0.01;
const TILE_LON = 0.015;
/** The box fetched around a tile's centre: the user is at most ~0.8 km from it, and the screen reaches 1.44 km. */
const BOX_M = 2400;
const MINOR_M = 1900;
const PATH_M = 800;
const BUILDING_FETCH_M = 1500;
const BUILDING_RADIUS_M = 1000;
const BUILDING_POINT_M = 1200;
const BUILDING_SPAN_M = 400;
export const MAX_BUILDINGS = 80;
const MAX_TILE_BUILDINGS = 4000;

export type Building = { ring: LL[]; height: number };
export type Tile = {
  /** `name` is for finding the street of an incident; it never goes to the apps. */
  roads: { class: string; name?: string; points: LL[] }[];
  /** False for a tile cached before street names were kept: it is fetched again once. */
  named?: boolean;
  water: LL[][];
  green: LL[][];
  buildings: Building[];
  area: string | null;
  fetchedAt: number;
};

const tileId = (lat: number, lon: number): { key: string; centre: { lat: number; lon: number } } => {
  const i = Math.floor(lat / TILE_LAT);
  const j = Math.floor(lon / TILE_LON);
  return { key: `${i}_${j}`, centre: { lat: round5((i + 0.5) * TILE_LAT), lon: round5((j + 0.5) * TILE_LON) } };
};
export const tileKey = (lat: number, lon: number): string => tileId(lat, lon).key;

// ---- The query ---------------------------------------------------------------

function box(c: { lat: number; lon: number }, m: number): string {
  const dLat = m / 110_540;
  const dLon = m / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  return [c.lat - dLat, c.lon - dLon, c.lat + dLat, c.lon + dLon].map((n) => n.toFixed(5)).join(",");
}

export function buildQuery(c: { lat: number; lon: number }): string {
  const b = box(c, BOX_M);
  const around = (m: number) => `(around:${m},${c.lat},${c.lon})`;
  return `[out:json][timeout:90];
is_in(${c.lat},${c.lon})->.a;
area.a[place~"^(neighbourhood|quarter|suburb|village|town|city)$"];
out tags;
(
way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${b});
way["railway"="rail"](${b});
way["highway"~"^(residential|unclassified|living_street)$"]${around(MINOR_M)};
way["highway"~"^(footway|path|cycleway|pedestrian)$"]${around(PATH_M)};
way["natural"="water"](${b});
relation["natural"="water"]["type"="multipolygon"](${b});
way["leisure"~"^(park|garden|playground|nature_reserve)$"](${b});
way["landuse"~"^(grass|forest|recreation_ground|village_green)$"](${b});
way["natural"="wood"](${b});
way["building"]${around(BUILDING_FETCH_M)};
);
out geom;`;
}

// ---- Parsing -----------------------------------------------------------------

const Geometry = z.array(z.object({ lat: z.number(), lon: z.number() }));
const Element = z.object({
  type: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
  geometry: Geometry.optional(),
  members: z
    .array(z.object({ type: z.string(), role: z.string().optional(), geometry: Geometry.optional() }))
    .optional(),
});
const Answer = z.object({ elements: z.array(z.unknown()) });

const PLACE_RANK = ["neighbourhood", "quarter", "suburb", "village", "town", "city"];
const MAJOR = /^(motorway|trunk|primary)(_link)?$/;
const STREET = /^(secondary|tertiary)(_link)?$/;
const MINOR = /^(residential|unclassified|living_street)$/;
const PATH = /^(footway|path|cycleway|pedestrian)$/;

function roadClass(tags: Record<string, string>): string | null {
  const h = tags.highway;
  if (h) return MAJOR.test(h) ? "major" : STREET.test(h) ? "street" : MINOR.test(h) ? "minor" : PATH.test(h) ? "path" : null;
  return tags.railway === "rail" ? "rail" : null;
}

const points = (g: { lat: number; lon: number }[]): LL[] => g.map((p) => [round5(p.lat), round5(p.lon)]);
const closed = (p: LL[]): boolean => p.length >= 4 && p[0]![0] === p.at(-1)![0] && p[0]![1] === p.at(-1)![1];

/** Joins open outer ways of a multipolygon end to end into closed rings. Ways that do not close are dropped. */
export function stitch(ways: LL[][]): LL[][] {
  const same = (a: LL, b: LL) => a[0] === b[0] && a[1] === b[1];
  const pool = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings: LL[][] = [];
  while (pool.length) {
    let ring = pool.pop()!;
    let grew = true;
    while (grew && !same(ring[0]!, ring.at(-1)!)) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i]!;
        const end = ring.at(-1)!;
        if (same(w[0]!, end)) ring = [...ring, ...w.slice(1)];
        else if (same(w.at(-1)!, end)) ring = [...ring, ...[...w].reverse().slice(1)];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

function heightOf(tags: Record<string, string>): number {
  const h = parseFloat(tags.height ?? "");
  const levels = parseFloat(tags["building:levels"] ?? "");
  const metres = Number.isFinite(h) && h > 0 ? h : Number.isFinite(levels) && levels > 0 ? levels * 3 + 1 : 9;
  return Math.min(150, Math.max(3, Math.round(metres)));
}

/** A closed outline of at most 13 points (the protocol limit): simplified a little more each time until it fits. */
export function fitRing(ring: LL[]): LL[] | null {
  if (!closed(ring)) return null;
  for (const tol of [0, 0.5, 1, 2, 4, 8]) {
    const open = simplify(ring.slice(0, -1), tol);
    if (open.length >= 3 && open.length + 1 <= 13) return [...open, open[0]!];
  }
  return null;
}

const MAX_AREAS = 250;
const MIN_AREA_SPAN_M = 25;

const span = (ring: LL[]): number => {
  const lats = ring.map((p) => p[0]);
  const lons = ring.map((p) => p[1]);
  return Math.hypot((Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos((ring[0]![0] * Math.PI) / 180), (Math.max(...lats) - Math.min(...lats)) * 110_540);
};

/** The biggest `max` rings that span at least 25 m. */
function largest(rings: LL[][], max: number): LL[][] {
  return rings
    .map((ring) => ({ ring, s: span(ring) }))
    .filter(({ s }) => s >= MIN_AREA_SPAN_M)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(({ ring }) => ring);
}

/** Turns the Overpass answer into a tile. Elements that are not valid are dropped one by one. Throws only when the answer is not an Overpass answer. */
export function parseOverpass(raw: unknown, now: number, report = { dropped: 0 }): Tile {
  const answer = Answer.parse(raw);
  const tile: Tile = { roads: [], water: [], green: [], buildings: [], area: null, fetchedAt: now, named: true };
  let rank = -1;
  for (const entry of answer.elements) {
    const parsed = Element.safeParse(entry);
    if (!parsed.success) {
      report.dropped++;
      continue;
    }
    const { type, tags = {}, geometry, members } = parsed.data;
    if (type === "area") {
      const r = PLACE_RANK.indexOf(tags.place ?? "");
      // The smallest place that holds the point: a neighbourhood before a suburb before a city.
      if (r >= 0 && tags.name && (rank < 0 || r < rank)) {
        rank = r;
        tile.area = tags.name;
      }
    } else if (type === "relation" && members) {
      const outer = members.filter((m) => m.type === "way" && m.role !== "inner" && m.geometry).map((m) => points(m.geometry!));
      if (tags.natural === "water") for (const ring of stitch(outer)) tile.water.push(simplify(ring, 3));
    } else if (type === "way" && geometry && geometry.length >= 2) {
      const p = points(geometry);
      if (tags.building) {
        const ring = fitRing(p);
        if (ring) tile.buildings.push({ ring, height: heightOf(tags) });
      } else if (tags.natural === "water") {
        if (closed(p)) tile.water.push(simplify(p, 3));
      } else if (tags.leisure || tags.landuse || tags.natural === "wood") {
        if (closed(p)) tile.green.push(simplify(p, 3));
      } else {
        const cls = roadClass(tags);
        if (cls) tile.roads.push({ class: cls, ...(cls !== "path" && cls !== "rail" && tags.name ? { name: tags.name.slice(0, 60) } : {}), points: simplify(p, 1.5) });
      }
    }
  }
  tile.buildings = tile.buildings.slice(0, MAX_TILE_BUILDINGS);
  // Specks of grass and ponds draw as dots; keep the larger shapes, at most this many of each.
  tile.water = largest(tile.water, MAX_AREAS);
  tile.green = largest(tile.green, MAX_AREAS);
  return tile;
}

// ---- Cutting the tile for a position ------------------------------------------

/**
 * What Around can show, in metres from you (it looks north): ground lines run from 150 m behind you to 1,600 m
 * ahead, areas further, and the screen is 1.44 x (north + 220) m wide at each distance. The rectangle adds 300 m
 * each way, because a new map is sent only after you moved 300 m. The Loops path sends a 1,920 m square (more).
 */
const VIEW: Rect = { west: -1500, east: 1500, south: -450, north: 1900 };
/** Order of importance when the budget runs out. */
const ROAD_ORDER = ["major", "street", "rail", "minor", "path"] as const;
/** At most this many of each. Paths and minor roads are dim and dotted, so they go first when the map is too big. */
const CAPS: Record<string, number> = { major: 60, street: 120, rail: 20, minor: 220, path: 100, water: 30, green: 30 };
/** Beyond this many metres from you, a class is not sent (a pixel is over 6 m there). */
const REACH_M: Record<string, number> = { minor: 1300, path: 700 };
/** Shorter minor roads and paths are stubs. */
const STUB_M = 30;
/** Smaller water and parks are specks (the Loops path drops under 1,024 m2). */
const MIN_AREA_M2 = 1024;
/** Points in all roads, water and parks of one message: about 40 KB; with 80 buildings the message stays near 60 KB. */
export const POINT_BUDGET = 1800;

/** A lens pixel is (north + 220) / 200 m wide; simplify to half of that, but never finer than 1.5 m or coarser than 6 m. */
const toleranceAt = (m: number): number => Math.min(6, Math.max(1.5, (0.5 * (m + 220)) / 200));

type Shape = { cls: string; pts: LL[]; near: number };

/** The map for `centre`: the ground in front of you (a rectangle), the most important and nearest first, within a point budget; and the nearest 80 buildings that pass the Loops limits. */
export function cutMap(tile: Tile, centre: { lat: number; lon: number }): LocalMap {
  const { toXY, toLL } = frame(centre);
  const near = (xy: [number, number][]): number => Math.min(...xy.map(([x, y]) => Math.hypot(x, y)));
  const back = (xy: [number, number][]): LL[] => xy.map(toLL);

  const lines: Shape[] = [];
  for (const road of tile.roads) {
    const fine = road.class === "minor" || road.class === "path";
    for (const piece of clipLine(road.points.map(toXY), VIEW)) {
      const d = near(piece);
      if (d > (REACH_M[road.class] ?? Infinity) || (fine && lengthM(piece) < STUB_M)) continue;
      const pts = simplify(back(piece), toleranceAt(d) * (fine ? 1.5 : 1));
      if (pts.length >= 2) lines.push({ cls: road.class, pts, near: d });
    }
  }
  const areas = (rings: LL[][], cls: string): Shape[] =>
    rings.flatMap((ring) => {
      const clipped = clipRing(ring.map(toXY), VIEW);
      if (!clipped.length || areaM2(clipped) < MIN_AREA_M2) return [];
      const d = near(clipped);
      const pts = simplify(back(clipped), toleranceAt(d) * 2);
      return pts.length >= 4 ? [{ cls, pts, near: d }] : [];
    });

  const byClass = new Map<string, Shape[]>();
  for (const s of [...lines, ...areas(tile.water, "water"), ...areas(tile.green, "green")]) byClass.set(s.cls, [...(byClass.get(s.cls) ?? []), s]);
  let points = 0;
  const kept = new Map<string, Shape[]>();
  for (const cls of ["major", "street", "water", "rail", "green", "minor", "path"]) {
    const chosen: Shape[] = [];
    for (const s of (byClass.get(cls) ?? []).sort((a, b) => a.near - b.near)) {
      if (chosen.length >= (CAPS[cls] ?? 0) || points + s.pts.length > POINT_BUDGET) continue;
      chosen.push(s);
      points += s.pts.length;
    }
    kept.set(cls, chosen);
  }

  const buildings = tile.buildings
    .flatMap((b) => {
      const pts = b.ring.map(([lat, lon]) => ({ lat, lon }));
      if (pts.some((p) => metresBetween(centre, p) > BUILDING_POINT_M)) return [];
      if (pts.some((p, i) => pts.slice(i + 1).some((q) => metresBetween(p, q) > BUILDING_SPAN_M))) return [];
      const metres = nearestOnPath(centre, b.ring)?.m ?? Infinity;
      return metres <= BUILDING_RADIUS_M ? [{ metres, ring: b.ring, height: b.height }] : [];
    })
    .sort((a, b) => a.metres - b.metres)
    .slice(0, MAX_BUILDINGS)
    .map(({ ring, height }) => ({ ring, height }));

  return {
    center: { lat: centre.lat, lon: centre.lon },
    roads: ROAD_ORDER.flatMap((cls) => (kept.get(cls) ?? []).map((s) => ({ class: cls, points: s.pts }))),
    water: (kept.get("water") ?? []).map((s) => s.pts),
    green: (kept.get("green") ?? []).map((s) => s.pts),
    ...(buildings.length ? { buildings } : {}),
  };
}

// ---- Disk cache ---------------------------------------------------------------

const LL_SCHEMA = z.tuple([z.number(), z.number()]);
const CacheFile = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  tile: z.object({
    roads: z.array(z.object({ class: z.string(), name: z.string().optional(), points: z.array(LL_SCHEMA) })),
    water: z.array(z.array(LL_SCHEMA)),
    green: z.array(z.array(LL_SCHEMA)),
    buildings: z.array(z.object({ ring: z.array(LL_SCHEMA), height: z.number() })),
    area: z.string().nullable(),
    fetchedAt: z.number(),
  }),
});

export class TileCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `map-${key}.json`);
  }

  /** A cached tile of any age, or null when there is none or the file is bad. */
  async read(key: string): Promise<Tile | null> {
    let text: string;
    try {
      text = await readFile(this.file(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("map cache unreadable", { key, error: String(error) });
      return null;
    }
    try {
      const parsed = CacheFile.safeParse(JSON.parse(text));
      // Version 1 files have no street names.
      if (parsed.success) return { ...parsed.data.tile, named: parsed.data.version === 2 } as Tile;
      log.warn("map cache file ignored", { key, reason: "does not match the format" });
    } catch (error) {
      log.warn("map cache file ignored", { key, reason: String(error) });
    }
    return null;
  }

  async write(key: string, tile: Tile): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      // Write beside the file, then rename, so a crash never leaves half a file.
      const tmp = `${this.file(key)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 2, tile }));
      await rename(tmp, this.file(key));
    } catch (error) {
      log.warn("map cache not written", { key, error: String(error) });
    }
  }
}

// ---- The provider: cache first, then one Overpass request at a time ------------

export type MapProviderOptions = { fetch: Fetch; cache: TileCache; url?: string; now?: () => number };

export class MapProvider {
  private readonly pacer = new Pacer(10_000, 15 * 60_000);
  private readonly tiles = new Map<string, Tile>();
  private busy = false;

  constructor(private readonly o: MapProviderOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** True when a request would be sent now (none running, no backoff). */
  retryDue(): boolean {
    return !this.busy && this.pacer.due(this.now());
  }

  /** The tile for a position: from memory or disk when fresh; from Overpass when not, keeping the old one if that fails. */
  async tileFor(pos: { lat: number; lon: number }): Promise<{ tile: Tile; fresh: boolean } | null> {
    const { key, centre } = tileId(pos.lat, pos.lon);
    const cached = this.tiles.get(key) ?? (await this.o.cache.read(key));
    if (cached) this.tiles.set(key, cached);
    if (cached && cached.named !== false && this.now() - cached.fetchedAt < CACHE_TTL_MS) return { tile: cached, fresh: true };
    // Stale or missing: one request at a time, and not while a failure is still backing off.
    if (this.busy || !this.pacer.due(this.now())) return cached ? { tile: cached, fresh: false } : null;
    this.busy = true;
    this.pacer.started(this.now());
    try {
      const res = await send(this.o.fetch, this.o.url ?? DEFAULT_OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ data: buildQuery(centre) }).toString(),
        timeoutMs: 120_000,
      });
      const report = { dropped: 0 };
      const tile = parseOverpass(JSON.parse(await readText(res, 40 * 1024 * 1024)), this.now(), report);
      this.pacer.succeeded();
      this.tiles.set(key, tile);
      await this.o.cache.write(key, tile);
      // These are the whole tile (about 5 x 5 km); a message to the app holds far fewer (see "map sent" at debug level).
      log.info("map tile loaded", { tileRoads: tile.roads.length, tileBuildings: tile.buildings.length, area: tile.area, dropped: report.dropped });
      return { tile, fresh: true };
    } catch (error) {
      // 429, 502, 503, 504 and timeouts all mean "later"; the old tile, if any, keeps serving.
      const wait = this.pacer.failed(this.now(), error instanceof HttpError ? error.retryAfterMs : undefined);
      log.warn("map request failed", { message: error instanceof Error ? error.message : String(error), retryInS: Math.round(wait / 1000), serving: cached ? "cached map" : "no map" });
      return cached ? { tile: cached, fresh: false } : null;
    } finally {
      this.busy = false;
    }
  }
}

// ---- Street names for incidents ------------------------------------------------

/** The widest title Around puts on a row is 440 px; leave room. */
const TITLE_PX = 400;

/** The name of the nearest named road within `maxM` of the point, or null. */
export function streetNear(tile: Tile, at: { lat: number; lon: number }, maxM = 40): string | null {
  let best: { m: number; name: string } | null = null;
  for (const road of tile.roads) {
    if (!road.name) continue;
    const hit = nearestOnPath(at, road.points);
    if (hit && hit.m <= maxM && (!best || hit.m < best.m)) best = { m: hit.m, name: road.name };
  }
  return best?.name ?? null;
}

/**
 * "Road closed · Prinsengracht" (from "Road closed for roadworks"). It must fit TITLE_PX: if not, the street loses its last words (a
 * cut at a word) and ends with "…"; if not even its first word fits, the title is the plain kind.
 */
export function titleWithStreet(kind: string, street: string | null, width: (s: string) => number): string {
  if (!street) return kind;
  // The street takes the room of " for roadworks"; the incident's kind still says roadworks.
  kind = kind.replace(/ for roadworks$/, "");
  const full = `${kind} · ${street}`;
  if (width(full) <= TITLE_PX) return full;
  const words = street.split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const cut = `${kind} · ${words.join(" ")}…`;
    if (width(cut) <= TITLE_PX) return cut;
  }
  return kind;
}
