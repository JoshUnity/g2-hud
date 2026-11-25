import { createGunzip } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { metresBetween } from "../../src/core/geo";
import type { Osint } from "../../src/core/protocol";
import { nearestOnPath, type LL } from "./geo";
import { send, type Fetch } from "./http";

export type Item = Osint["items"][number];
export type Pos = { lat: number; lon: number };

/** Where incidents come from. One implementation for now: NDW, in the Netherlands. */
export interface IncidentProvider {
  readonly name: string;
  /** The least time between two downloads. */
  readonly minIntervalMs: number;
  /** True when this provider has data for the position. Outside, the feed says "no data source". */
  covers(pos: Pos): boolean;
  /** Items within `keepM` of `pos` that are valid at `now` (ms). */
  load(pos: Pos, now: number, keepM: number): Promise<Item[]>;
}

/** An empty provider: the interface is ready, nothing is covered. */
export const noIncidents: IncidentProvider = {
  name: "none",
  minIntervalMs: Infinity,
  covers: () => false,
  load: async () => [],
};

// ---- NDW: DATEX II v3 "actueel beeld" ------------------------------------------

export const NDW_URL = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
/** A rough box round the Netherlands. The file holds Dutch roads only, so a spot just across the border gets an empty answer. */
export const inNetherlands = (p: Pos): boolean => p.lat >= 50.75 && p.lat <= 53.55 && p.lon >= 3.3 && p.lon <= 7.25;

const MAX_XML_BYTES = 80 * 1024 * 1024;

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== "#") return entities[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });

/** The text of the first `<tag>` in a chunk (a tag name without attributes). */
const text = (chunk: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(chunk);
  return m ? unescapeXml(m[1]!.trim()) : null;
};

const num = (s: string | null): number | null => {
  const n = s === null ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Every line string in a record as [lat, lon] points (DATEX posList is "lat lon lat lon ..."). */
function linePaths(chunk: string): LL[][] {
  const paths: LL[][] = [];
  for (const m of chunk.matchAll(/<loc:posList>([^<]*)<\/loc:posList>/g)) {
    const n = m[1]!.trim().split(/\s+/).map(Number);
    if (n.length < 4 || n.length % 2 || n.some((v) => !Number.isFinite(v))) continue;
    const pts: LL[] = [];
    for (let i = 0; i < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
    if (pts.every(([lat, lon]) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) paths.push(pts);
  }
  return paths;
}

function pointOf(chunk: string): LL | null {
  const m = /<loc:pointCoordinates><loc:latitude>([^<]*)<\/loc:latitude><loc:longitude>([^<]*)<\/loc:longitude>/.exec(chunk);
  const lat = num(m?.[1] ?? null);
  const lon = num(m?.[2] ?? null);
  return lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 ? null : [lat, lon];
}

const WORKS = new Set(["roadMaintenance", "constructionWork", "maintenanceWork"]);
const HIGH = new Set(["high", "highest"]);

/**
 * What an NDW record means for the glasses. Severity 0-3:
 *   3  accident; road fully closed (roadClosed) in a high-severity situation
 *   2  road or carriageway closed; road closed; object on the road
 *   1  lane closed; lane shift, narrow lanes or other works; broken-down vehicle; other obstruction
 *   0  never sent
 * A situation NDW rates high or highest adds 1 (at most 3). Speed limits, diversion signs, bridge openings and
 * hard-shoulder running are not incidents and are left out.
 */
export function classify(type: string, record: string, overall: string | null): { kind: string; severity: number; title: string } | null {
  const bump = overall !== null && HIGH.has(overall) ? 1 : 0;
  const cap = (n: number) => Math.min(3, n);
  const cause = text(record, "sit:causeType");
  const works = cause !== null && WORKS.has(cause);
  switch (type) {
    case "Accident":
      return { kind: "collision", severity: 3, title: "Accident" };
    case "VehicleObstruction":
      return text(record, "sit:vehicleObstructionType") === "brokenDownVehicle"
        ? { kind: "breakdown", severity: cap(1 + bump), title: "Broken-down vehicle" }
        : { kind: "obstruction", severity: cap(1 + bump), title: "Vehicle on the road" };
    case "GeneralObstruction":
      return text(record, "sit:obstructionType") === "objectOnTheRoad"
        ? { kind: "obstruction", severity: cap(2 + bump), title: "Object on the road" }
        : { kind: "obstruction", severity: cap(1 + bump), title: "Obstruction" };
    case "RoadOrCarriagewayOrLaneManagement": {
      const sub = text(record, "sit:roadOrCarriagewayOrLaneManagementType");
      const why = works ? " for roadworks" : "";
      if (sub === "roadClosed") return { kind: works ? "roadworks" : "closure", severity: cap(2 + bump), title: `Road closed${why}` };
      if (sub === "carriagewayClosures") return { kind: works ? "roadworks" : "closure", severity: 2, title: `Road closed${why}` };
      if (sub === "laneClosures") return { kind: works ? "roadworks" : "lanes", severity: cap(1 + bump), title: `Lane closed${why}` };
      if ((sub === "lanesDeviated" || sub === "narrowLanes" || sub === "other") && works) return { kind: "roadworks", severity: 1, title: "Roadworks" };
      return null;
    }
    default:
      return null;
  }
}

export type NdwOptions = { pos: Pos; now: number; keepM: number };

/** Reads the file in pieces and keeps the records that pass: valid now, with a position, within `keepM`. */
export class NdwParser {
  private rest = "";
  private bytes = 0;
  readonly items: Item[] = [];
  dropped = 0;
  private readonly seen = new Set<string>();
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly o: NdwOptions) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_XML_BYTES) throw new Error("NDW file too large");
    this.rest += this.decoder.write(chunk);
    for (;;) {
      const start = this.rest.indexOf("<sit:situation ");
      if (start < 0) {
        // Keep a tail that might hold the start of the next tag.
        this.rest = this.rest.slice(-16);
        return;
      }
      const end = this.rest.indexOf("</sit:situation>", start);
      if (end < 0) {
        this.rest = this.rest.slice(start);
        return;
      }
      this.situation(this.rest.slice(start, end));
      this.rest = this.rest.slice(end + "</sit:situation>".length);
    }
  }

  private situation(chunk: string): void {
    if (text(chunk, "com:informationStatus") === "test" || text(chunk, "com:informationStatus") === "exercise") return;
    const overall = text(chunk, "sit:overallSeverity");
    for (const m of chunk.matchAll(/<sit:situationRecord xsi:type="sit:(\w+)" id="([^"]*)"[^>]*>([\s\S]*?)<\/sit:situationRecord>/g)) {
      try {
        this.record(m[1]!, unescapeXml(m[2]!), m[3]!, overall);
      } catch {
        this.dropped++;
      }
    }
  }

  private record(type: string, id: string, body: string, overall: string | null): void {
    const prob = text(body, "sit:probabilityOfOccurrence");
    if (prob !== null && prob !== "certain" && prob !== "probable") return;
    const start = Date.parse(text(body, "com:overallStartTime") ?? "");
    const end = Date.parse(text(body, "com:overallEndTime") ?? "");
    if (Number.isNaN(start) || start > this.o.now) return;
    if (!Number.isNaN(end) && end < this.o.now) return;
    const meaning = classify(type, body, overall);
    if (!meaning || this.seen.has(id)) return;
    const paths = linePaths(body);
    const point = pointOf(body);
    const geometry = paths.length ? paths : point ? [[point]] : [];
    let best: { m: number; at: LL } | null = null;
    for (const path of geometry) {
      const hit = nearestOnPath(this.o.pos, path);
      if (hit && (!best || hit.m < best.m)) best = hit;
    }
    if (!best) {
      this.dropped++;
      return;
    }
    if (best.m > this.o.keepM) return;
    this.seen.add(id);
    this.items.push({
      id: `ndw:${id}`,
      ...meaning,
      lat: Math.round(best.at[0] * 1e6) / 1e6,
      lon: Math.round(best.at[1] * 1e6) / 1e6,
      area: null,
      lines: paths.slice(0, 8).map((p) => p.slice(0, 64)),
    });
  }
}

export function ndw(fetchFn: Fetch): IncidentProvider {
  return {
    name: "ndw",
    minIntervalMs: 5 * 60_000,
    covers: inNetherlands,
    async load(pos, now, keepM) {
      const res = await send(fetchFn, NDW_URL, { timeoutMs: 60_000, headers: { Accept: "application/gzip" } });
      if (!res.body) throw new Error("NDW answered with no body");
      const parser = new NdwParser({ pos, now, keepM });
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        createGunzip(),
        new Writable({
          write(chunk: Buffer, _enc, done) {
            try {
              parser.push(chunk);
              done();
            } catch (error) {
              done(error as Error);
            }
          },
        }),
      );
      return parser.items;
    },
  };
}

/** The items to show for a position: within `radiusM`, most severe then nearest first, at most 40. */
export function itemsNear(items: Item[], me: Pos, radiusM: number): Item[] {
  const metres = (i: Item) => (i.lat !== null && i.lon !== null ? metresBetween(me, { lat: i.lat, lon: i.lon }) : 1e9);
  return items
    .filter((i) => metres(i) <= radiusM)
    .sort((a, b) => b.severity - a.severity || metres(a) - metres(b))
    .slice(0, 40);
}
