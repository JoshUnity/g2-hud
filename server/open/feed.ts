import { metresBetween } from "../../src/core/geo";
import { MapSchema, type LocalMap, type Osint } from "../../src/core/protocol";
import { log } from "../log";
import { AircraftService, nearest, type Plane } from "./aircraft";
import { itemsNear, type IncidentProvider, type Item } from "./incidents";
import { textWidth } from "../../src/core/text";
import { cutMap, streetNear, tileKey, titleWithStreet, type MapProvider, type Tile } from "./map";
import { Pacer } from "./pacer";

/**
 * The feed for people without the Loops daemon. It makes the same `Osint` and `LocalMap` as `LoopsFeed` from open
 * data: aircraft from public ADS-B networks, the map from OpenStreetMap, incidents from NDW. It asks for data only
 * while a client that needs it is connected and it knows where you are.
 */

/** A move smaller than this is GPS noise. */
export const JUMP_M = 25;
/** A fix this coarse (m) is ignored once there is a better one. */
const COARSE_M = 2000;
/** Send a new map when you moved this far from the centre of the last one sent. */
const MAP_MOVE_M = 300;
const ITEM_RADIUS_M = 3000;
/** Incidents are kept this far round the spot they were loaded for, so a walk needs no new download. */
const KEEP_M = 8000;
/** Aircraft older than this are not shown as current. */
const AIRCRAFT_STALE_MS = 30_000;
/** Incidents older than this (two failed downloads in a row) are not shown as current. */
const ITEMS_STALE_MS = 15 * 60_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 1000;
const TRAIL_POINTS = 20;

export type Position = { lat: number; lon: number; accuracy?: number };
type Fix = { lat: number; lon: number; source: "gps" | "home" };

export type OpenFeedOptions = {
  aircraft: AircraftService;
  map: MapProvider | null;
  incidents: IncidentProvider | null;
  /** True while a client that needs this data is connected. */
  active: () => boolean;
  /** HUD_LAT and HUD_LON. */
  home?: { lat: number; lon: number } | null;
  now?: () => number;
  /** How often the feed looks for work. */
  tickMs?: number;
};

export class OpenFeed {
  private fix: Fix | null;
  private planes: { list: Plane[]; at: number } | null = null;
  private readonly trails = new Map<string, { points: [number, number][]; at: number }>();
  private tile: { key: string; tile: Tile | null; fresh: boolean } | null = null;
  private sentMap: LocalMap | null = null;
  private sentMapTile: Tile | null = null;
  /** Titles with the street, by incident id; rebuilt when the map tile or the incident list changes. */
  private readonly titled = new Map<string, string>();
  private titledTile: Tile | null = null;
  private items: { list: Item[]; at: number } | null = null;
  private readonly incidentPacer: Pacer | null;
  private busy = { aircraft: false, map: false, items: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPublish = 0;
  private cached: Osint | null = null;

  constructor(
    private readonly o: OpenFeedOptions,
    private onUpdate: (osint: Osint) => void,
    private onMap: (map: LocalMap) => void,
  ) {
    this.fix = o.home ? { ...o.home, source: "home" } : null;
    this.incidentPacer = o.incidents ? new Pacer(o.incidents.minIntervalMs, 30 * 60_000) : null;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The glasses' view now. Built on demand, so a new client gets it without waiting for a poll. */
  get latest(): Osint {
    return this.build();
  }

  latestMap(): LocalMap | null {
    return this.sentMap;
  }

  /** A fix from a client. A move under 25 m is ignored; a coarse fix is ignored once there is a good one. */
  setPosition(p: Position): void {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
    const old = this.fix;
    if (old?.source === "gps") {
      if (p.accuracy !== undefined && p.accuracy > COARSE_M) return;
      if (metresBetween(old, p) < JUMP_M) return;
    }
    this.fix = { lat: p.lat, lon: p.lon, source: "gps" };
    // Coordinates only in debug lines, rounded to about 1 km.
    log.debug("position changed", { lat: p.lat.toFixed(2), lon: p.lon.toFixed(2) });
    this.publish();
    void this.tick();
  }

  private async tick(): Promise<void> {
    const fix = this.fix;
    if (!fix || !this.o.active()) return;
    const t = this.now();
    const jobs: Promise<void>[] = [];
    if (!this.busy.aircraft && this.o.aircraft.enabled && this.o.aircraft.due()) jobs.push(this.pollAircraft(fix));
    const key = tileKey(fix.lat, fix.lon);
    if (this.o.map && !this.busy.map && (this.tile?.key !== key || (!this.tile.fresh && this.o.map.retryDue()))) jobs.push(this.loadTile(fix, key));
    const inc = this.o.incidents;
    if (inc?.covers(fix) && !this.busy.items && this.incidentPacer!.due(t)) jobs.push(this.loadItems(fix, inc));
    if (!jobs.length && t - this.lastPublish >= HEARTBEAT_MS) this.publish();
    await Promise.all(jobs);
  }

  private async pollAircraft(fix: Fix): Promise<void> {
    this.busy.aircraft = true;
    try {
      const list = await this.o.aircraft.poll(fix);
      if (list) {
        const t = this.now();
        for (const p of list) {
          const trail = this.trails.get(p.id) ?? { points: [], at: t };
          const last = trail.points.at(-1);
          if (!last || last[0] !== p.lat || last[1] !== p.lon) trail.points = [...trail.points, [p.lat, p.lon] as [number, number]].slice(-TRAIL_POINTS - 1);
          trail.at = t;
          this.trails.set(p.id, trail);
        }
        for (const [id, trail] of this.trails) if (t - trail.at > 120_000) this.trails.delete(id);
        this.planes = { list, at: t };
      }
    } finally {
      this.busy.aircraft = false;
    }
    this.publish();
  }

  private async loadTile(fix: Fix, key: string): Promise<void> {
    this.busy.map = true;
    try {
      const got = await this.o.map!.tileFor(fix);
      this.tile = { key, tile: got?.tile ?? this.tile?.tile ?? null, fresh: got?.fresh ?? false };
    } finally {
      this.busy.map = false;
    }
    this.publish();
  }

  private async loadItems(fix: Fix, provider: IncidentProvider): Promise<void> {
    this.busy.items = true;
    const pacer = this.incidentPacer!;
    pacer.started(this.now());
    try {
      const list = await provider.load(fix, this.now(), KEEP_M);
      this.items = { list, at: this.now() };
      this.titled.clear();
      pacer.succeeded();
      // No coordinates: only that incidents work. `count` is what was kept near you, not the whole country.
      log.info("incidents loaded", { source: provider.name, count: list.length });
    } catch (error) {
      const wait = pacer.failed(this.now());
      log.warn("incident download failed", { provider: provider.name, message: error instanceof Error ? error.message : String(error), retryInS: Math.round(wait / 1000) });
    } finally {
      this.busy.items = false;
    }
    this.publish();
  }

  /** Builds the view, sends it, and sends a new map when needed. */
  private publish(): void {
    this.lastPublish = this.now();
    const osint = this.build();
    this.cached = osint;
    this.maybeSendMap();
    this.onUpdate(osint);
  }

  private maybeSendMap(): void {
    const fix = this.fix;
    const tile = this.tile?.tile;
    if (!fix || !tile) return;
    const known = this.sentMap && this.sentMapTile === tile;
    if (known && metresBetween(this.sentMap!.center, fix) < MAP_MOVE_M) return;
    const parsed = MapSchema.safeParse(cutMap(tile, fix));
    if (!parsed.success) {
      log.warn("map did not pass the protocol check", { issue: parsed.error.issues[0]?.message });
      return;
    }
    log.debug("map sent", {
      roads: parsed.data.roads.length,
      water: parsed.data.water.length,
      green: parsed.data.green.length,
      buildings: parsed.data.buildings?.length ?? 0,
      bytes: JSON.stringify(parsed.data).length,
    });
    this.sentMap = parsed.data;
    this.sentMapTile = tile;
    this.onMap(parsed.data);
  }

  /** "Road closed · Prinsengracht": the nearest named road of the map tile within 40 m, when the tile is known. */
  private withStreet(item: Item): Item {
    const tile = this.tile?.tile;
    if (!tile || tile.named === false || item.lat === null || item.lon === null) return item;
    if (this.titledTile !== tile) {
      this.titled.clear();
      this.titledTile = tile;
    }
    let title = this.titled.get(item.id);
    if (title === undefined) {
      title = titleWithStreet(item.title, streetNear(tile, { lat: item.lat, lon: item.lon }), textWidth);
      this.titled.set(item.id, title);
    }
    return title === item.title ? item : { ...item, title };
  }

  private build(): Osint {
    const fix = this.fix;
    const t = this.now();
    const base = { connected: true, error: null, at: t / 1000, vehicles: [] };
    // No position: the apps show "no fix". Nothing is asked for, so nothing is missing either.
    if (!fix) return { ...base, me: null, items: [], aircraft: [] };

    const missing: NonNullable<Osint["missing"]> = [];
    const me = { lat: fix.lat, lon: fix.lon, source: fix.source, area: this.tile?.tile?.area ?? null, heading: null };

    const fresh = this.planes && t - this.planes.at <= AIRCRAFT_STALE_MS ? this.planes.list : null;
    if (!fresh) missing.push("aircraft");
    const aircraft = nearest(fresh ?? [], fix).map((p) => ({ ...p, trail: (this.trails.get(p.id)?.points ?? []).slice(0, -1).slice(-TRAIL_POINTS) }));

    const inc = this.o.incidents;
    let items: Item[] = [];
    if (inc?.covers(fix) && this.items && t - this.items.at <= ITEMS_STALE_MS) items = itemsNear(this.items.list, fix, ITEM_RADIUS_M).map((i) => this.withStreet(i));
    else missing.push("items");

    // Who answered, so the apps can say so. Only while the aircraft are current.
    const source = fresh && this.o.aircraft.active ? { aircraftSource: this.o.aircraft.active } : {};
    return { ...base, me, items, aircraft, ...source, ...(missing.length ? { missing } : {}) };
  }
}
