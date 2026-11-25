import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AircraftService, adsbFi, airplanesLive, nearest, openSky, parseAdsbx, parseOpenSky, providersFor, type AircraftProvider } from "../server/open/aircraft";
import { Pacer } from "../server/open/pacer";
import { fakeFetch, json, ok, status } from "./openkit";

const AMS = { lat: 52.3791, lon: 4.9003 };

describe("ADSB Exchange v2 format (adsb.fi, airplanes.live)", () => {
  it("reads the recorded adsb.fi answer: airborne only, callsign trimmed, vertical rate from baro_rate", () => {
    const planes = parseAdsbx(json("adsbfi.json"));
    expect(planes.map((p) => p.id)).toEqual(["896190", "484c53", "398564", "484c5a"]);
    const klm = planes.find((p) => p.id === "484c53")!;
    expect(klm).toMatchObject({ callsign: "KLM930", altitude_ft: 3200, vrate: -896, speed_kt: 246.7, emergency: false });
    expect(klm.track).toBeCloseTo(240.63);
  });

  it("drops the ground aircraft, and bad records one by one", () => {
    const raw = json("adsbfi.json");
    raw.ac.push({ hex: "zz", lat: 1, lon: 1 }, { hex: "abcdef", lat: 99, lon: 1 }, "junk", { hex: "abcdef" });
    const report = { dropped: 0 };
    const planes = parseAdsbx(raw, report);
    expect(planes).toHaveLength(4);
    expect(report.dropped).toBe(4);
  });

  it("flags emergencies by the emergency field and by squawk 7500, 7600 and 7700", () => {
    const base = { hex: "abcdef", lat: 52, lon: 4, alt_baro: 5000 };
    const flags = parseAdsbx({
      ac: [
        { ...base, emergency: "none", squawk: "1200" },
        { ...base, hex: "abcde1", emergency: "general" },
        { ...base, hex: "abcde2", emergency: "none", squawk: "7700" },
        { ...base, hex: "abcde3", squawk: "7500" },
        { ...base, hex: "abcde4", squawk: "7600" },
        { ...base, hex: "abcde5", emergency: "lifeguard" },
      ],
    }).map((p) => p.emergency);
    expect(flags).toEqual([false, true, true, true, true, false]);
  });

  it("uses geom_rate when there is no baro_rate, and leaves vrate out when neither exists", () => {
    const base = { lat: 52, lon: 4, alt_baro: 5000 };
    const [a, b] = parseAdsbx({ ac: [{ ...base, hex: "abcdef", geom_rate: 640 }, { ...base, hex: "abcdee" }] });
    expect(a!.vrate).toBe(640);
    expect("vrate" in b!).toBe(false);
  });

  it("keeps an aircraft with only a position: no callsign, altitude, speed or track", () => {
    const report: { dropped: number; ground?: number; raw?: number } = { dropped: 0 };
    const planes = parseAdsbx({ ac: [{ hex: "abcdef", lat: 52, lon: 4 }, { hex: "abcde0", lat: 52, lon: 4, alt_baro: "ground" }, { hex: "bad", lat: 1, lon: 1 }] }, report);
    expect(planes).toEqual([{ id: "abcdef", callsign: null, lat: 52, lon: 4, altitude_ft: null, track: null, speed_kt: null, emergency: false }]);
    expect(report).toMatchObject({ raw: 3, ground: 1, dropped: 1 });
  });

  it("shows the registration when there is no callsign", () => {
    const [a, b] = parseAdsbx({ ac: [{ hex: "abcdef", r: "PH-EZO", flight: "  ", lat: 52, lon: 4 }, { hex: "abcde1", r: "PH-XYZ", flight: "KLM1 ", lat: 52, lon: 4 }] });
    expect(a!.callsign).toBe("PH-EZO");
    expect(b!.callsign).toBe("KLM1");
  });

  it("counts for the recorded answer: 6 raw, 2 on the ground, 4 kept", () => {
    const report: { dropped: number; ground?: number; raw?: number } = { dropped: 0 };
    expect(parseAdsbx(json("adsbfi.json"), report)).toHaveLength(4);
    expect(report).toEqual({ raw: 6, ground: 2, dropped: 0 });
  });

  it("throws on an answer with no aircraft list", () => {
    expect(() => parseAdsbx({ msg: "oops" })).toThrow();
  });

  it("asks the documented URLs with the descriptive User-Agent", async () => {
    const f = fakeFetch(() => ok(json("adsbfi.json")));
    await adsbFi(f).fetchAircraft(AMS, 35);
    await airplanesLive(f).fetchAircraft(AMS, 35);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://opendata.adsb.fi/api/v3/lat/52.3791/lon/4.9003/dist/35",
      "https://api.airplanes.live/v2/point/52.3791/4.9003/35",
    ]);
    expect(f.calls.every((c) => c.headers["User-Agent"] === "g2-hud (open source)" && c.method === "GET")).toBe(true);
  });
});

describe("OpenSky", () => {
  it("reads the recorded answer and converts metric units to feet, knots and feet per minute", () => {
    const planes = parseOpenSky(json("opensky.json"));
    expect(planes.map((p) => p.id)).toEqual(["896314", "4bb210", "484c50"]);
    const uae = planes[0]!;
    expect(uae).toMatchObject({ callsign: "UAE78P", altitude_ft: 33000, speed_kt: 492, vrate: 0, track: 102.2, emergency: false });
    // 6.5 m/s up = 1,280 ft/min; 617.22 m = 2,025 ft; 110.87 m/s = 216 kt.
    expect(planes[1]).toMatchObject({ vrate: 1280, altitude_ft: 2025, speed_kt: 216 });
  });

  it("drops aircraft on the ground and bad vectors, and accepts an empty answer", () => {
    const report = { dropped: 0 };
    expect(parseOpenSky({ states: [["abcdef", "X", "c", 0, 0, 4, 52, 100, false, 50, 10, 0, null, 100, "7700", false, 0], [1, 2], null] }, report)).toHaveLength(1);
    expect(report.dropped).toBe(2);
    expect(parseOpenSky({ time: 1, states: null })).toEqual([]);
    expect(parseOpenSky({ states: [["abcdef", "X", "c", 0, 0, 4, 52, 100, false, 50, 10, 0, null, 100, "7700", false, 0]] })[0]!.emergency).toBe(true);
  });

  it("gets a token with client credentials, sends it as a bearer, and reuses it", async () => {
    let tokens = 0;
    const f = fakeFetch((url) => {
      if (url.includes("openid-connect/token")) {
        tokens++;
        return ok({ access_token: `tok${tokens}`, expires_in: 1800 });
      }
      return ok(json("opensky.json"));
    });
    const p = openSky(f, { clientId: "id", clientSecret: "secret" });
    expect(p.minIntervalMs).toBe(30_000);
    await p.fetchAircraft(AMS, 35);
    await p.fetchAircraft(AMS, 35);
    const token = f.calls[0]!;
    expect(token.url).toBe("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token");
    expect(token.method).toBe("POST");
    expect(new URLSearchParams(token.body)).toEqual(new URLSearchParams({ grant_type: "client_credentials", client_id: "id", client_secret: "secret" }));
    const states = f.calls.filter((c) => c.url.startsWith("https://opensky-network.org/api/states/all?"));
    expect(states).toHaveLength(2);
    expect(states[0]!.headers.Authorization).toBe("Bearer tok1");
    expect(tokens).toBe(1);
    const q = new URL(states[0]!.url).searchParams;
    expect(["lamin", "lomin", "lamax", "lomax"].every((k) => q.has(k))).toBe(true);
    expect(Number(q.get("lamax")) - Number(q.get("lamin"))).toBeCloseTo((2 * 35 * 1.852) / 110.54, 1);
  });

  it("gets a new token after a 401", async () => {
    let tokens = 0;
    let states = 0;
    const f = fakeFetch((url) => {
      if (url.includes("token")) return ok({ access_token: `t${++tokens}` });
      return ++states === 1 ? status(401) : ok(json("opensky.json"));
    });
    const p = openSky(f, { clientId: "id", clientSecret: "s" });
    await expect(p.fetchAircraft(AMS, 35)).rejects.toThrow("401");
    await p.fetchAircraft(AMS, 35);
    expect(tokens).toBe(2);
  });

  it("works without credentials, slowly, and sends no Authorization", async () => {
    const f = fakeFetch(() => ok(json("opensky.json")));
    const p = openSky(f);
    expect(p.minIntervalMs).toBeGreaterThanOrEqual(216_000);
    await p.fetchAircraft(AMS, 35);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers.Authorization).toBeUndefined();
  });
});

describe("choosing providers", () => {
  const f = fakeFetch(() => ok({}));
  const names = (source?: string) => providersFor(source, f).map((p) => p.name);
  it("defaults to adsb.fi, because airplanes.live now answers 403 without a feeder", () => expect(names(undefined)).toEqual(["adsb.fi"]));
  it("airplanes.live falls back to adsb.fi", () => expect(names("airplanes.live")).toEqual(["airplanes.live", "adsb.fi"]));
  it("opensky and off", () => {
    expect(names("opensky")).toEqual(["opensky"]);
    expect(names("off")).toEqual([]);
  });
  it("an unknown value gives the default", () => expect(names("planefinder")).toEqual(["adsb.fi"]));
});

describe("fallback, rate limits and backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const stub = (name: string, minIntervalMs: number, answers: (n: number) => unknown): AircraftProvider & { calls: number } => {
    const p = {
      name,
      minIntervalMs,
      calls: 0,
      async fetchAircraft() {
        p.calls++;
        const a = answers(p.calls);
        if (a instanceof Error) throw a;
        return a as never[];
      },
    };
    return p;
  };

  it("asks at most once every 5 seconds", async () => {
    const a = stub("a", 5000, () => []);
    const s = new AircraftService([a]);
    expect(await s.poll(AMS)).toEqual([]);
    expect(s.due()).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(await s.poll(AMS)).toBeNull();
    expect(a.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await s.poll(AMS)).toEqual([]);
    expect(a.calls).toBe(2);
  });

  it("falls back to the second provider in the same poll when the first is refused, and does not ask the first again for an hour", async () => {
    const { HttpError } = await import("../server/open/http");
    const first = stub("airplanes.live", 5000, () => new HttpError(403, "HTTP 403"));
    const second = stub("adsb.fi", 5000, () => []);
    const s = new AircraftService([first, second]);
    expect(await s.poll(AMS)).toEqual([]);
    expect(s.active).toBe("adsb.fi");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await s.poll(AMS);
    }
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(11);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await s.poll(AMS);
    expect(first.calls).toBe(2);
  });

  it("goes back to the first provider when it recovers", async () => {
    const { HttpError } = await import("../server/open/http");
    const first = stub("first", 5000, (n) => (n === 1 ? new HttpError(503, "HTTP 503") : []));
    const second = stub("second", 5000, () => []);
    const s = new AircraftService([first, second]);
    await s.poll(AMS);
    expect(s.active).toBe("second");
    await vi.advanceTimersByTimeAsync(10_000);
    await s.poll(AMS);
    expect(s.active).toBe("first");
  });

  it("waits for Retry-After on a 429, and doubles the wait on repeated errors", async () => {
    const { HttpError } = await import("../server/open/http");
    const a = stub("a", 5000, (n) => (n === 1 ? new HttpError(429, "HTTP 429", 90_000) : n <= 3 ? new Error("boom") : []));
    const s = new AircraftService([a]);
    expect(await s.poll(AMS)).toBeNull();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(s.due()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.due()).toBe(true);
    await s.poll(AMS); // second failure: 5 s * 2^2 = 20 s
    await vi.advanceTimersByTimeAsync(19_000);
    expect(s.due()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.due()).toBe(true);
    await s.poll(AMS); // third failure: 5 s * 2^3 = 40 s
    await vi.advanceTimersByTimeAsync(39_000);
    expect(s.due()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await s.poll(AMS)).toEqual([]);
  });

  it("OpenSky is paced at 30 s with credentials", async () => {
    const p = openSky(fakeFetch(() => ok({ states: [] })), { clientId: "a", clientSecret: "b" });
    expect(p.minIntervalMs).toBe(30_000);
  });

  it("Pacer: the wait never goes over its cap", () => {
    const pacer = new Pacer(5000, 60_000);
    let t = 0;
    for (let i = 0; i < 20; i++) t = pacer.failed(t);
    expect(t).toBe(60_000);
    pacer.succeeded();
    expect(pacer.failureCount).toBe(0);
  });
});

describe("nearest", () => {
  it("keeps the 30 nearest", () => {
    const planes = Array.from({ length: 50 }, (_, i) => ({ id: String(i).padStart(6, "0"), callsign: null, lat: AMS.lat + i * 0.01, lon: AMS.lon, altitude_ft: 1, track: null, speed_kt: null, emergency: false }));
    const kept = nearest([...planes].reverse(), AMS);
    expect(kept).toHaveLength(30);
    expect(kept[0]!.id).toBe("000000");
    expect(kept[29]!.id).toBe("000029");
  });
});
