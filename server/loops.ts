import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { metresBetween } from "../src/core/geo";
import type { LocalMap, Osint } from "../src/core/protocol";
import { log } from "./log";

/**
 * Read-only bridge to the Loops daemon on the Pi. Like Loops.app, it opens an SSH
 * stream-local forward to the daemon's Unix socket and speaks HTTP over it. It only
 * ever sends GET requests.
 */

const REMOTE_SOCKET = "/run/user/1000/loops/api.sock";
const POLL_MS = 10_000;
const MAP_EVERY_MS = 10 * 60_000;
/** Loops clips the map to a square of 1.2 x this radius: 1920 m, the half screen (1440 m) plus room to move. */
const MAP_RADIUS_M = 1600;
/** Ask for a new map when the fix is this far from the map's centre, or Loops is still fetching tiles. */
const MAP_MOVE_M = 300;
/** Never ask for the map more often than this for those two reasons. */
const MAP_MIN_MS = 30_000;
const ITEM_RADIUS_M = 3000;

// ---- Loops API shapes (only the fields the glasses use) -----------------------

const Envelope = z.object({ success: z.boolean(), data: z.unknown(), error: z.string().nullable().optional() });
const LatLon = z.tuple([z.number(), z.number()]);

const LocationSchema = z.object({
  fix: z.object({ lat: z.number(), lon: z.number(), heading_deg: z.number().nullable().optional() }).nullable().optional(),
  place: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).nullable().optional(),
  area: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).nullable().optional(),
});

const CityItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.number().int().min(0).max(3),
  title: z.string(),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
  area: z.string().nullable().optional(),
  shape: z.object({ type: z.enum(["line", "area"]), paths: z.array(z.array(LatLon)) }).nullable().optional(),
});

const AircraftSchema = z.object({
  id: z.string(),
  callsign: z.string().nullable().optional(),
  lat: z.number(),
  lon: z.number(),
  altitude_ft: z.number().nullable().optional(),
  on_ground: z.boolean().optional(),
  track: z.number().nullable().optional(),
  speed_kt: z.number().nullable().optional(),
  emergency: z.boolean().optional(),
  trail: z.array(LatLon).optional(),
});

const VehicleSchema = z.object({ lat: z.number(), lon: z.number(), mode: z.string() });
const LoopsMapSchema = z.object({
  center: z.object({ lat: z.number(), lon: z.number(), source: z.string() }),
  roads: z.array(z.object({ class: z.string(), points: z.array(LatLon) })),
  water: z.array(z.array(LatLon)),
  green: z.array(z.array(LatLon)),
  /** false while Loops is still fetching map tiles (it answers with what it has). */
  complete: z.boolean().optional(),
});

const nameOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && "name" in v && typeof v.name === "string" ? v.name : null;

// ---- HTTP over the Unix socket ------------------------------------------------

export function getJson(socketPath: string, path: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", headers: { Accept: "application/json", Host: "loops" } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) req.destroy(new Error("Loops response too large"));
        else chunks.push(chunk);
      });
      // A connection closed in the middle of the body emits no "end" and no request error.
      res.on("close", () => {
        if (!res.complete) reject(new Error(`Loops closed the connection on ${path}`));
      });
      res.on("end", () => {
        try {
          const envelope = Envelope.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!envelope.success) reject(new Error(envelope.error ?? `Loops returned HTTP ${res.statusCode}`));
          else resolve(envelope.data);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Loops timed out on ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

// ---- Turning Loops data into the glasses' contract ----------------------------

/** The map as Loops sends it; the centre also says where it came from. */
type LoopsMap = LocalMap & { center: { source?: string } };

export type LoopsRaw = {
  location: unknown;
  items: unknown;
  aircraft: unknown;
  live: unknown;
  map: LoopsMap | null;
};

type Missing = NonNullable<Osint["missing"]>[number];

/** Reads `value[key]` without trusting the shape of `value`. */
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Keeps the entries of a list that match the schema; one bad entry does not cost the rest.
 * Returns null when `list` is not a list (that part of the feed is unknown, not empty).
 */
function valid<T>(schema: z.ZodType<T>, list: unknown, report: { dropped: number }): T[] | null {
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) report.dropped++;
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Builds the glasses' view. Never throws: a part Loops did not send is named in
 * `missing`, and invalid entries are dropped and counted in `report.dropped`.
 */
export function toOsint(raw: LoopsRaw, now: number, report = { dropped: 0 }): Osint {
  const missing: Missing[] = [];
  const loc = LocationSchema.safeParse(raw.location);
  if (!loc.success) missing.push("location");
  const fix = loc.success ? loc.data.fix : null;
  const centre = raw.map?.center.source;
  const fallback: "gps" | "home" | "default" = centre === "gps" || centre === "default" ? centre : "home";
  const me = fix
    ? { lat: fix.lat, lon: fix.lon, source: "gps" as const, area: nameOf(loc.success ? (loc.data.place ?? loc.data.area) : null), heading: fix.heading_deg ?? null }
    : raw.map
      ? { lat: raw.map.center.lat, lon: raw.map.center.lon, source: fallback, area: loc.success ? nameOf(loc.data.place ?? loc.data.area) : null, heading: null }
      : null;

  // Rank before each cut: the feeds come in no distance or severity order.
  const metres = (p: { lat?: number | null; lon?: number | null }): number =>
    me && p.lat != null && p.lon != null ? metresBetween(me, { lat: p.lat, lon: p.lon }) : 1e9;

  const cityItems = valid(CityItemSchema, raw.items, report);
  if (!cityItems) missing.push("items");
  const items = (cityItems ?? [])
    .filter((item) => {
      if (item.severity >= 3) return true;
      if (!me || item.lat == null || item.lon == null) return false;
      return metresBetween(me, { lat: item.lat, lon: item.lon }) <= ITEM_RADIUS_M;
    })
    .sort((a, b) => b.severity - a.severity || metres(a) - metres(b))
    .slice(0, 40)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      severity: item.severity,
      title: item.title,
      lat: item.lat ?? null,
      lon: item.lon ?? null,
      area: item.area ?? null,
      lines: (item.shape?.paths ?? []).slice(0, 8).map((path) => path.slice(0, 64)),
    }));

  // Local ADS-B wins over public sightings with the same id; those add trails.
  const local = valid(AircraftSchema, field(raw.aircraft, "aircraft"), report);
  if (!local) missing.push("aircraft");
  const liveAircraft = valid(AircraftSchema, field(raw.live, "aircraft"), report);
  const liveVehicles = valid(VehicleSchema, field(raw.live, "vehicles"), report);
  if (!liveAircraft || !liveVehicles) missing.push("live");
  const trails = new Map((liveAircraft ?? []).map((a) => [a.id, a.trail ?? []]));
  const byId = new Map<string, z.infer<typeof AircraftSchema>>();
  for (const a of [...(liveAircraft ?? []), ...(local ?? [])]) byId.set(a.id, a);
  const aircraft = [...byId.values()]
    .filter((a) => !a.on_ground)
    .sort((a, b) => metres(a) - metres(b))
    .slice(0, 30)
    .map((a) => ({
      id: a.id,
      callsign: a.callsign?.trim() || null,
      lat: a.lat,
      lon: a.lon,
      altitude_ft: a.altitude_ft ?? null,
      track: a.track ?? null,
      speed_kt: a.speed_kt ?? null,
      emergency: a.emergency ?? false,
      trail: (a.trail ?? trails.get(a.id) ?? []).slice(-20),
    }));

  const vehicles = me
    ? (liveVehicles ?? []).filter((v) => metresBetween(me, v) <= ITEM_RADIUS_M).slice(0, 150)
    : [];

  return { connected: true, error: null, at: now, me, items, aircraft, vehicles, ...(missing.length ? { missing } : {}) };
}

/** Whether the map should be fetched again: none yet, too old, or the fix moved away (or tiles were pending). */
export function mapDue(
  map: { center: { lat: number; lon: number } } | null,
  fix: { lat: number; lon: number } | null,
  ageMs: number,
  complete: boolean,
): boolean {
  if (!map || ageMs > MAP_EVERY_MS) return true;
  const moved = fix !== null && metresBetween(map.center, fix) > MAP_MOVE_M;
  return (moved || !complete) && ageMs > MAP_MIN_MS;
}

/** True while a child process has neither exited nor been killed by a signal. */
export const isRunning = (child: ChildProcess | null): boolean => !!child && child.exitCode === null && child.signalCode === null;

// ---- The tunnel and the poller ------------------------------------------------

export class LoopsFeed {
  private ssh: ChildProcess | null = null;
  private readonly dir = join(tmpdir(), `g2hud-${process.getuid?.() ?? "user"}`);
  readonly socketPath = join(this.dir, "loops.sock");
  private timer: ReturnType<typeof setTimeout> | null = null;
  private map: LoopsMap | null = null;
  private mapAt = 0;
  private mapComplete = true;
  /** The last "answered in part" summary, so a lasting problem is logged once, not every poll. */
  private partial = "";
  private stopped = false;
  private failures = 0;
  latest: Osint | null = null;

  constructor(
    private target: string,
    private onUpdate: (osint: Osint) => void,
    private onMap: (map: LocalMap) => void,
  ) {
    if (!/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target)) {
      throw new Error("LOOPS_SSH must look like user@host, for example pi@raspberrypi.local");
    }
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ssh?.kill();
    rmSync(this.socketPath, { force: true });
  }

  latestMap(): LocalMap | null {
    return this.map;
  }

  private ensureTunnel(): void {
    if (isRunning(this.ssh)) return;
    rmSync(this.socketPath, { force: true });
    const args = [
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "StreamLocalBindUnlink=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ControlMaster=no",
      "-L", `${this.socketPath}:${REMOTE_SOCKET}`,
      this.target,
    ];
    const ssh = spawn("/usr/bin/ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ssh.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-400)));
    // A missing or unrunnable ssh binary emits "error"; with no listener it would stop the server.
    ssh.on("error", (error) => {
      log.warn("loops tunnel could not start", { error: error.message });
      this.lastSshError = error.message;
      if (this.ssh === ssh) this.ssh = null;
    });
    ssh.on("exit", (code) => {
      if (!this.stopped) log.warn("loops tunnel closed", { code, stderr: stderr.trim() });
      this.lastSshError = stderr.trim().split("\n").pop() ?? null;
    });
    this.ssh = ssh;
  }

  private lastSshError: string | null = null;

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      this.ensureTunnel();
      for (let i = 0; i < 40 && !existsSync(this.socketPath); i++) await new Promise((r) => setTimeout(r, 250));
      if (!existsSync(this.socketPath)) throw new Error(this.lastSshError ?? "SSH tunnel to the Pi did not open");
      const failed: string[] = [];
      const get = (path: string) =>
        getJson(this.socketPath, path).catch((error: unknown) => {
          failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      const [location, items, aircraft, live] = await Promise.all([
        get("/v1/location"),
        get("/v1/city/items?hours=6&limit=200"),
        get("/v1/aircraft"),
        get("/v1/city/live"),
      ]);
      if (location === null && items === null && aircraft === null) throw new Error("Loops did not answer");
      const loc = LocationSchema.safeParse(location);
      const fix = loc.success ? (loc.data.fix ?? null) : null;
      if (mapDue(this.map, fix, Date.now() - this.mapAt, this.mapComplete)) {
        const map = LoopsMapSchema.safeParse(await get(`/v1/map/local?radius_m=${MAP_RADIUS_M}`));
        if (map.success) {
          this.map = { center: map.data.center, roads: map.data.roads, water: map.data.water, green: map.data.green };
          this.mapComplete = map.data.complete ?? true;
          this.mapAt = Date.now();
          this.onMap(this.map);
        }
      }
      const report = { dropped: 0 };
      this.latest = toOsint({ location, items, aircraft, live, map: this.map }, Date.now() / 1000, report);
      const partial = failed.length || report.dropped ? JSON.stringify({ failed, dropped: report.dropped }) : "";
      if (partial && partial !== this.partial) log.warn("loops answered in part", { failed, dropped: report.dropped });
      this.partial = partial;
      this.failures = 0;
      this.onUpdate(this.latest);
    } catch (error) {
      this.failures++;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("loops poll failed", { message, failures: this.failures });
      // Keep only the position: old aircraft and incidents must not look current.
      this.latest = { at: this.latest?.at ?? 0, me: this.latest?.me ?? null, items: [], aircraft: [], vehicles: [], connected: false, error: message };
      this.onUpdate(this.latest);
    }
    // Back off while the Pi is away: 10 s, then up to 5 minutes.
    const delay = this.failures === 0 ? POLL_MS : Math.min(300_000, POLL_MS * 2 ** Math.min(this.failures, 5));
    this.timer = setTimeout(() => void this.tick(), delay);
  }
}
