import type { LocalMap, Osint } from "../../src/core/protocol";
import { log } from "../log";
import { AircraftService, providersFor } from "./aircraft";
import { OpenFeed, type Position } from "./feed";
import { ndw } from "./incidents";
import type { Fetch } from "./http";
import { MapProvider, TileCache } from "./map";

/** What the server needs from a feed; `LoopsFeed` and `OpenFeed` both have it. */
export type Feed = {
  start(): void;
  stop(): void;
  readonly latest: Osint | null;
  latestMap(): LocalMap | null;
};

export type FeedChoice = {
  kind: "loops" | "open" | "off";
  feed: Feed | null;
  /** Gives a client's `position` message to the feed. Does nothing unless the open feed is on. */
  position: (p: Position) => void;
};

export type Factories = {
  loops: (target: string) => Feed;
  open: () => Feed & { setPosition(p: Position): void };
};

/**
 * LOOPS_SSH set: Loops, and nothing else. The open feed is not even built, so no request can go to a public
 * server, and a position message is dropped here: not stored, not passed on, not logged.
 * Otherwise the open feed, unless OPEN_FEED=off.
 */
export function chooseFeed(env: Record<string, string | undefined>, make: Factories): FeedChoice {
  if (env.LOOPS_SSH) return { kind: "loops", feed: make.loops(env.LOOPS_SSH), position: () => undefined };
  if (env.OPEN_FEED === "off") return { kind: "off", feed: null, position: () => undefined };
  const feed = make.open();
  return { kind: "open", feed, position: (p) => feed.setPosition(p) };
}

function home(env: Record<string, string | undefined>): { lat: number; lon: number } | null {
  if (!env.HUD_LAT || !env.HUD_LON) return null;
  const lat = Number(env.HUD_LAT);
  const lon = Number(env.HUD_LON);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  log.warn("HUD_LAT and HUD_LON are not valid coordinates and are ignored");
  return null;
}

/** The open feed with its providers, as set by the environment. `fetchFn` and `cacheDir` are for tests. */
export function buildOpenFeed(
  env: Record<string, string | undefined>,
  hooks: { active: () => boolean; onUpdate: (o: Osint) => void; onMap: (m: LocalMap) => void },
  fetchFn: Fetch = fetch,
  cacheDir: string,
  tickMs?: number,
): OpenFeed {
  return new OpenFeed(
    {
      aircraft: new AircraftService(providersFor(env.AIRCRAFT_SOURCE, fetchFn, env)),
      map: new MapProvider({ fetch: fetchFn, cache: new TileCache(cacheDir), url: env.OVERPASS_URL || undefined }),
      incidents: ndw(fetchFn),
      active: hooks.active,
      home: home(env),
      tickMs,
    },
    hooks.onUpdate,
    hooks.onMap,
  );
}
