import { z } from "zod";
import { metresBetween } from "../../src/core/geo";
import type { Osint } from "../../src/core/protocol";
import { log } from "../log";
import { getJson, HttpError, send, readText, type Fetch } from "./http";
import { Pacer } from "./pacer";

export type Plane = Omit<Osint["aircraft"][number], "trail">;
export type Centre = { lat: number; lon: number };

/** How far from you the apps look: Sky draws 60 km, so 35 nm (65 km) fills it. */
export const RADIUS_NM = 35;
const KM_PER_NM = 1.852;
/** Same cut as the Loops path: the 30 nearest. */
export const MAX_AIRCRAFT = 30;

export interface AircraftProvider {
  readonly name: string;
  /** The least time between two requests. */
  readonly minIntervalMs: number;
  /** Aircraft in the air near `centre`. Bad records are dropped one by one; a bad response throws. */
  fetchAircraft(centre: Centre, radiusNm: number): Promise<Plane[]>;
}

// ---- ADS-B Exchange v2 format: airplanes.live and adsb.fi ---------------------

const EMERGENCY_CODES = new Set(["general", "nordo", "unlawful", "downed"]);
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

const AdsbRecord = z.object({
  hex: z.string().regex(/^~?[0-9a-fA-F]{6}$/),
  flight: z.string().optional(),
  /** Registration, shown when there is no callsign. */
  r: z.string().optional().catch(undefined),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Feet, or the word "ground". */
  alt_baro: z.union([z.number(), z.string()]).optional().catch(undefined),
  gs: z.number().optional().catch(undefined),
  track: z.number().optional().catch(undefined),
  baro_rate: z.number().optional().catch(undefined),
  geom_rate: z.number().optional().catch(undefined),
  squawk: z.string().optional().catch(undefined),
  emergency: z.string().optional().catch(undefined),
});

/** Turns an ADSBx v2 answer into planes. Aircraft on the ground are left out, as the Loops path does. */
export function parseAdsbx(raw: unknown, report: { dropped: number; ground?: number; raw?: number } = { dropped: 0 }): Plane[] {
  const list = z.object({ ac: z.array(z.unknown()).optional(), aircraft: z.array(z.unknown()).optional() }).parse(raw);
  const records = list.ac ?? list.aircraft;
  if (!records) throw new Error("answer has no aircraft list");
  report.raw = records.length;
  return records.flatMap((entry) => {
    const r = AdsbRecord.safeParse(entry);
    if (!r.success) {
      report.dropped++;
      return [];
    }
    const a = r.data;
    if (a.alt_baro === "ground") {
      report.ground = (report.ground ?? 0) + 1;
      return [];
    }
    const altitude = typeof a.alt_baro === "number" ? a.alt_baro : null;
    const rate = a.baro_rate ?? a.geom_rate;
    return [
      {
        id: a.hex.toLowerCase(),
        // No callsign (private and some military flights): the registration, and the app falls back to the hex code.
        callsign: a.flight?.trim() || a.r?.trim() || null,
        lat: a.lat,
        lon: a.lon,
        altitude_ft: altitude,
        ...(rate !== undefined ? { vrate: rate } : {}),
        track: a.track ?? null,
        speed_kt: a.gs ?? null,
        emergency: (a.emergency !== undefined && EMERGENCY_CODES.has(a.emergency)) || (a.squawk !== undefined && EMERGENCY_SQUAWKS.has(a.squawk)),
      },
    ];
  });
}

/** A provider that speaks ADSBx v2: the URL says where. */
function adsbx(name: string, fetchFn: Fetch, url: (c: Centre, nm: number) => string): AircraftProvider {
  return {
    name,
    // Both services allow 1 request per second; one per 5 s is plenty for a radar.
    minIntervalMs: 5000,
    async fetchAircraft(centre, radiusNm) {
      const report: { dropped: number; ground?: number; raw?: number } = { dropped: 0 };
      const planes = parseAdsbx(await getJson(fetchFn, url(centre, radiusNm), { timeoutMs: 10_000 }), report);
      log.debug("aircraft answer", { provider: name, raw: report.raw, onGround: report.ground ?? 0, invalid: report.dropped, kept: planes.length });
      return planes;
    },
  };
}

const fix = (n: number): string => n.toFixed(4);

export const airplanesLive = (fetchFn: Fetch): AircraftProvider =>
  adsbx("airplanes.live", fetchFn, (c, nm) => `https://api.airplanes.live/v2/point/${fix(c.lat)}/${fix(c.lon)}/${Math.round(nm)}`);

export const adsbFi = (fetchFn: Fetch): AircraftProvider =>
  adsbx("adsb.fi", fetchFn, (c, nm) => `https://opendata.adsb.fi/api/v3/lat/${fix(c.lat)}/lon/${fix(c.lon)}/dist/${Math.round(nm)}`);

// ---- OpenSky ------------------------------------------------------------------

const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";
const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;
const MS_TO_FPM = 196.8504;

/** State vector: [0] icao24, [1] callsign, [5] lon, [6] lat, [7] baro alt m, [8] on ground, [9] m/s, [10] track, [11] vertical m/s, [13] geo alt m, [14] squawk. */
const StateVector = z.array(z.unknown()).min(15);
const num = z.number().nullable().catch(null);

export function parseOpenSky(raw: unknown, report = { dropped: 0 }): Plane[] {
  const body = z.object({ states: z.array(z.unknown()).nullable() }).parse(raw);
  return (body.states ?? []).flatMap((entry) => {
    const v = StateVector.safeParse(entry);
    const hex = v.success ? z.string().regex(/^[0-9a-fA-F]{6}$/).safeParse(v.data[0]) : null;
    const lat = v.success ? z.number().min(-90).max(90).safeParse(v.data[6]) : null;
    const lon = v.success ? z.number().min(-180).max(180).safeParse(v.data[5]) : null;
    if (!v.success || !hex?.success || !lat?.success || !lon?.success) {
      report.dropped++;
      return [];
    }
    const d = v.data;
    if (d[8] === true) return [];
    const alt = num.parse(d[7] ?? d[13]);
    const speed = num.parse(d[9]);
    const rate = num.parse(d[11]);
    const callsign = typeof d[1] === "string" ? d[1].trim() : "";
    return [
      {
        id: hex.data.toLowerCase(),
        callsign: callsign || null,
        lat: lat.data,
        lon: lon.data,
        altitude_ft: alt === null ? null : Math.round(alt * M_TO_FT),
        ...(rate !== null ? { vrate: Math.round(rate * MS_TO_FPM) } : {}),
        track: num.parse(d[10]),
        speed_kt: speed === null ? null : Math.round(speed * MS_TO_KT),
        emergency: typeof d[14] === "string" && EMERGENCY_SQUAWKS.has(d[14]),
      },
    ];
  });
}

export type OpenSkyOptions = { clientId?: string; clientSecret?: string; now?: () => number };

/**
 * OpenSky with OAuth2 client credentials when both are set; anonymous otherwise (400 credits a day, so one request
 * every ~4 minutes). With credentials: one request every 30 s.
 */
export function openSky(fetchFn: Fetch, options: OpenSkyOptions = {}): AircraftProvider {
  const { clientId, clientSecret } = options;
  const now = options.now ?? Date.now;
  const authed = Boolean(clientId && clientSecret);
  let token: { value: string; expiresAt: number } | null = null;

  async function bearer(): Promise<Record<string, string>> {
    if (!authed) return {};
    if (!token || now() > token.expiresAt) {
      const res = await send(fetchFn, TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId!, client_secret: clientSecret! }).toString(),
        timeoutMs: 10_000,
      });
      const body = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() }).parse(JSON.parse(await readText(res, 64 * 1024)));
      // Tokens last 30 minutes; renew a minute early.
      token = { value: body.access_token, expiresAt: now() + ((body.expires_in ?? 1800) - 60) * 1000 };
    }
    return { Authorization: `Bearer ${token.value}` };
  }

  return {
    name: "opensky",
    minIntervalMs: authed ? 30_000 : 220_000,
    async fetchAircraft(c, nm) {
      const km = nm * KM_PER_NM;
      const dLat = km / 110.54;
      const dLon = km / (111.32 * Math.max(0.1, Math.cos((c.lat * Math.PI) / 180)));
      const q = new URLSearchParams({
        lamin: fix(Math.max(-90, c.lat - dLat)),
        lomin: fix(Math.max(-180, c.lon - dLon)),
        lamax: fix(Math.min(90, c.lat + dLat)),
        lomax: fix(Math.min(180, c.lon + dLon)),
      });
      try {
        return parseOpenSky(await getJson(fetchFn, `${STATES_URL}?${q}`, { headers: await bearer(), timeoutMs: 15_000 }));
      } catch (error) {
        // An expired or revoked token: get a new one next time.
        if (error instanceof HttpError && error.status === 401) token = null;
        throw error;
      }
    },
  };
}

// ---- Choosing and falling back ------------------------------------------------

export const AIRCRAFT_SOURCES = ["airplanes.live", "adsb.fi", "opensky", "off"] as const;
export type AircraftSource = (typeof AIRCRAFT_SOURCES)[number];

/**
 * The providers to try, in order. adsb.fi is the default: airplanes.live has limited its public API to its feeders
 * (it answers 403 with a request to write to them), so it is only used when asked for, and then falls back to adsb.fi.
 */
export function providersFor(source: string | undefined, fetchFn: Fetch, env: Record<string, string | undefined> = {}): AircraftProvider[] {
  const wanted = (AIRCRAFT_SOURCES as readonly string[]).includes(source ?? "") ? (source as AircraftSource) : "adsb.fi";
  if (source && wanted !== source) log.warn("unknown AIRCRAFT_SOURCE, using adsb.fi", { source });
  switch (wanted) {
    case "airplanes.live":
      return [airplanesLive(fetchFn), adsbFi(fetchFn)];
    case "opensky":
      return [openSky(fetchFn, { clientId: env.OPENSKY_CLIENT_ID, clientSecret: env.OPENSKY_CLIENT_SECRET })];
    case "off":
      return [];
    default:
      return [adsbFi(fetchFn)];
  }
}

/** A refusal that will not clear soon (no access, no such endpoint): do not ask again for an hour. */
const REFUSED_WAIT_MS = 3_600_000;
const MAX_WAIT_MS = 300_000;

/**
 * Asks the providers in order. A provider that fails waits (backoff, Retry-After) while the next one answers; the
 * first one is asked again when its wait ends. Each provider has its own pace.
 */
export class AircraftService {
  private readonly pacers: Pacer[];
  /** The provider that gave the last answer. */
  active: string | null = null;

  constructor(
    private readonly providers: AircraftProvider[],
    private readonly now: () => number = Date.now,
  ) {
    this.pacers = providers.map((p) => new Pacer(p.minIntervalMs, Math.max(MAX_WAIT_MS, p.minIntervalMs * 4)));
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  /** True when `poll` would send a request now. */
  due(): boolean {
    const t = this.now();
    return this.pacers.some((p) => p.due(t));
  }

  /** The planes from the first provider that answers, or null when none is due or all failed. */
  async poll(centre: Centre): Promise<Plane[] | null> {
    for (const [i, provider] of this.providers.entries()) {
      const pacer = this.pacers[i]!;
      const t = this.now();
      if (!pacer.due(t)) continue;
      pacer.started(t);
      try {
        const planes = await provider.fetchAircraft(centre, RADIUS_NM);
        pacer.succeeded();
        if (this.active !== provider.name) log.info("aircraft source", { provider: provider.name });
        this.active = provider.name;
        return planes;
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 0;
        const refused = status === 401 || status === 403 || status === 404;
        const wait = pacer.failed(this.now(), refused ? REFUSED_WAIT_MS : error instanceof HttpError ? error.retryAfterMs : undefined);
        log.warn("aircraft request failed", { provider: provider.name, message: error instanceof Error ? error.message : String(error), retryInS: Math.round(wait / 1000) });
      }
    }
    return null;
  }
}

/** The nearest `MAX_AIRCRAFT`, each with its trail. */
export function nearest(planes: Plane[], me: Centre): Plane[] {
  return planes
    .map((p) => ({ p, m: metresBetween(me, p) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, MAX_AIRCRAFT)
    .map(({ p }) => p);
}
