import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopsFeed, getJson, isRunning, mapDue, parseLoopsMap, toOsint } from "../server/loops";
import { metresBetween } from "../src/core/geo";
import type { Osint } from "../src/core/protocol";

const ME = { lat: 47.2311, lon: -31.4826 };
/** A point `km` kilometres north of ME. */
const north = (km: number) => ({ lat: ME.lat + km / 110.574, lon: ME.lon });
const plane = (id: string, km: number, extra: object = {}) => ({ id, ...north(km), altitude_ft: 3000, ...extra });
const item = (id: string, severity: number, km: number) => ({ id, kind: "k", severity, title: id, ...north(km) });
const location = { fix: { lat: ME.lat, lon: ME.lon } };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function socketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loops-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen<S extends NetServer | HttpServer>(server: S, path: string): Promise<S> {
  await new Promise<void>((r) => server.listen(path, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return server;
}

/** Answers with headers and part of a body, then closes the connection. */
const cutShort = (socket: import("node:net").Socket) => {
  socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"success\":true,\"data\":");
    setTimeout(() => socket.end(), 20);
  });
};

describe("getJson", () => {
  it("rejects when the connection closes in the middle of the body", async () => {
    const path = join(await socketDir(), "api.sock");
    await listen(createNetServer(cutShort), path);
    await expect(getJson(path, "/v1/x", 5000)).rejects.toThrow("closed the connection");
  });
});

describe("toOsint", () => {
  it("keeps the good entries when one entry is invalid, and counts the bad one", () => {
    const report = { dropped: 0 };
    const osint = toOsint(
      {
        location,
        items: [item("a", 1, 0.2), { ...item("bad", 4, 0.2) }, item("crit", 3, 0.3)],
        aircraft: { aircraft: [plane("p1", 2), { id: "nopos", altitude_ft: 1000 }] },
        live: { vehicles: [], aircraft: [] },
        map: null,
      },
      1,
      report,
    );
    expect(osint.items.map((i) => i.id)).toEqual(["crit", "a"]);
    expect(osint.aircraft.map((a) => a.id)).toEqual(["p1"]);
    expect(report.dropped).toBe(2);
    expect(osint.missing).toBeUndefined();
  });

  it("marks a part that did not answer as missing, not empty", () => {
    const osint = toOsint({ location, items: null, aircraft: null, live: null, map: null }, 1);
    expect(osint.missing).toEqual(["items", "aircraft", "live"]);
    expect(osint.connected).toBe(true);
  });

  it("labels a position from the map centre with the map's own source", () => {
    const map = { center: { ...ME, source: "default" }, roads: [], water: [], green: [] };
    expect(toOsint({ location: null, items: [], aircraft: { aircraft: [] }, live: null, map }, 1).me?.source).toBe("default");
    const odd = { ...map, center: { ...ME, source: "place" } };
    expect(toOsint({ location: { fix: null }, items: [], aircraft: { aircraft: [] }, live: null, map: odd }, 1).me?.source).toBe("home");
  });

  it("keeps the nearest aircraft and the critical items when it cuts the lists", () => {
    const far = Array.from({ length: 35 }, (_, i) => plane(`far${i}`, 70 + i));
    const near = [plane("near1", 1), plane("near2", 2), plane("near3", 3)];
    const minor = Array.from({ length: 45 }, (_, i) => item(`minor${i}`, 0, 0.2));
    const osint = toOsint(
      { location, items: [...minor, item("crit", 3, 0.3)], aircraft: { aircraft: near }, live: { vehicles: [], aircraft: far }, map: null },
      1,
    );
    expect(osint.aircraft).toHaveLength(30);
    expect(osint.aircraft.slice(0, 3).map((a) => a.id)).toEqual(["near1", "near2", "near3"]);
    expect(osint.items).toHaveLength(40);
    expect(osint.items[0]?.id).toBe("crit");
  });
});

describe("map refresh", () => {
  const map = { center: ME };
  it("asks again when the fix has moved away from the map centre", () => {
    expect(mapDue(null, null, 0, true)).toBe(true);
    expect(mapDue(map, ME, 60_000, true)).toBe(false);
    const moved = north(0.6);
    expect(metresBetween(ME, moved)).toBeGreaterThan(300);
    expect(mapDue(map, moved, 60_000, true)).toBe(true);
    // Not more often than every 30 s for a move.
    expect(mapDue(map, moved, 10_000, true)).toBe(false);
    expect(mapDue(map, ME, 11 * 60_000, true)).toBe(true);
  });
  it("asks again while Loops is still fetching tiles", () => {
    expect(mapDue(map, ME, 60_000, false)).toBe(true);
  });
});

describe("ssh tunnel", () => {
  it("treats a child killed by a signal as dead", async () => {
    const child: ChildProcess = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    expect(isRunning(child)).toBe(true);
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(child.exitCode).toBeNull();
    expect(isRunning(child)).toBe(false);
    expect(isRunning(null)).toBe(false);
  });
});

type FeedInternals = {
  ensureTunnel: () => void;
  tick: () => Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  socketPath: string;
  latest: Osint | null;
};

describe("LoopsFeed target", () => {
  it("gives a neutral example when LOOPS_SSH is not user@host", () => {
    expect(() => new LoopsFeed("raspberrypi.local", () => {}, () => {})).toThrow("for example pi@raspberrypi.local");
    expect(() => new LoopsFeed("pi@raspberrypi.local", () => {}, () => {})).not.toThrow();
  });
});

describe("LoopsFeed poll", () => {
  function feed(onUpdate: (o: Osint) => void): FeedInternals {
    const f = new LoopsFeed("user@host", onUpdate, () => {}) as unknown as FeedInternals;
    f.ensureTunnel = () => {};
    cleanups.push(() => {
      if (f.timer) clearTimeout(f.timer);
    });
    return f;
  }

  it("goes on polling when one response is cut short", async () => {
    const path = join(await socketDir(), "api.sock");
    const ok = (data: unknown) => JSON.stringify({ success: true, data, error: null });
    await listen(
      createHttpServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.url?.startsWith("/v1/city/items")) {
          res.writeHead(200, { "content-length": "1000" });
          res.write('{"success":true,"data":');
          setTimeout(() => res.destroy(), 20);
        } else if (req.url === "/v1/location") res.end(ok(location));
        else if (req.url === "/v1/aircraft") res.end(ok({ aircraft: [plane("p1", 2)] }));
        else if (req.url === "/v1/city/live") res.end(ok({ vehicles: [], aircraft: [] }));
        else res.end(JSON.stringify({ success: false, data: null, error: "no map" }));
      }),
      path,
    );
    const updates: Osint[] = [];
    const f = feed((o) => updates.push(o));
    f.socketPath = path;
    await f.tick();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ connected: true, missing: ["items"] });
    expect(updates[0]?.aircraft.map((a) => a.id)).toEqual(["p1"]);
    expect(f.timer).not.toBeNull();
  });

  it("drops old aircraft and incidents when Loops is not reachable", async () => {
    const updates: Osint[] = [];
    const f = feed((o) => updates.push(o));
    const old = toOsint({ location, items: [item("crit", 3, 0.3)], aircraft: { aircraft: [plane("p1", 2)] }, live: null, map: null }, 5);
    f.latest = old;
    f.ensureTunnel = () => {
      throw new Error("no route");
    };
    await f.tick();
    expect(updates[0]).toMatchObject({ connected: false, error: "no route", at: 5, me: old.me, items: [], aircraft: [], vehicles: [] });
  });
});

describe("parseLoopsMap buildings", () => {
  const base = { center: { lat: ME.lat, lon: ME.lon, source: "gps" }, roads: [{ class: "primary", points: [[ME.lat, ME.lon], [ME.lat + 0.001, ME.lon]] }], water: [], green: [] };
  /** A closed square `km` north of ME. */
  const building = (km: number, height_m = 10) => {
    const { lat, lon } = north(km);
    const d = 0.0001;
    return { points: [[lat, lon], [lat + d, lon], [lat + d, lon + d], [lat, lon + d], [lat, lon]], height_m };
  };

  it("leaves the buildings key out when Loops sends none", () => {
    const result = parseLoopsMap(base);
    expect(result).not.toBeNull();
    expect("buildings" in result!.map).toBe(false);
    expect(result!.map.roads).toHaveLength(1);
    expect("buildings" in parseLoopsMap({ ...base, buildings: [] })!.map).toBe(false);
  });

  it("trims to 1000 m and 80, nearest first, and renames the fields", () => {
    const many = Array.from({ length: 120 }, (_, i) => building(0.005 + i * 0.0001));
    const far = building(1.5);
    const map = parseLoopsMap({ ...base, buildings: [far, ...many.reverse()] })!.map;
    expect(map.buildings).toHaveLength(80);
    const firsts = map.buildings!.map((b) => metresBetween(ME, { lat: b.ring[0]![0], lon: b.ring[0]![1] }));
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(Math.max(...firsts)).toBeLessThanOrEqual(1000);
    expect(map.buildings![0]).toEqual({ ring: many[many.length - 1]!.points, height: 10 });
    const onlyFar = parseLoopsMap({ ...base, buildings: [far] })!.map;
    expect("buildings" in onlyFar).toBe(false);
  });

  it("keeps the roads when a building is malformed", () => {
    const map = parseLoopsMap({ ...base, buildings: [{ points: "nope", height_m: 5 }, { points: [[1, 2]], height_m: 5 }, building(0.1)] })!.map;
    expect(map.roads).toHaveLength(1);
    expect(map.buildings).toHaveLength(1);
    const whole = parseLoopsMap({ ...base, buildings: "garbage" })!.map;
    expect(whole.roads).toHaveLength(1);
    expect("buildings" in whole).toBe(false);
  });

  it("clamps heights to 3..150", () => {
    const map = parseLoopsMap({ ...base, buildings: [building(0.1, 1), building(0.2, 400)] })!.map;
    expect(map.buildings!.map((b) => b.height)).toEqual([3, 150]);
  });

  it("drops a building with any point over 1200 m away", () => {
    const b = building(0.1);
    const stray = { ...b, points: [b.points[0], [0, 0], ...b.points.slice(2)] };
    const map = parseLoopsMap({ ...base, buildings: [stray, building(0.2)] })!.map;
    expect(map.roads).toHaveLength(1);
    expect(map.buildings).toHaveLength(1);
    expect(parseLoopsMap({ ...base, buildings: [stray] })!.map.buildings).toBeUndefined();
  });

  it("drops a building whose ring spans more than 400 m", () => {
    const b = building(0.1);
    const far = north(0.1 + 0.5);
    const wide = { ...b, points: [b.points[0], [far.lat, far.lon], ...b.points.slice(2)] };
    const map = parseLoopsMap({ ...base, buildings: [wide, building(0.2)] })!.map;
    expect(map.buildings).toHaveLength(1);
  });

  it("drops a building with a latitude or longitude out of range", () => {
    const b = building(0.1);
    const bad = (pt: number[]) => ({ ...b, points: [b.points[0], pt, ...b.points.slice(2)] });
    const map = parseLoopsMap({ ...base, buildings: [bad([95, 0]), bad([0, 200])] })!.map;
    expect(map.roads).toHaveLength(1);
    expect(map.buildings).toBeUndefined();
  });
});

describe("toOsint vertical rate", () => {
  const vrates = (aircraft: object[], live: object[] | null = null) =>
    toOsint({ location, items: [], aircraft: { aircraft }, live: live && { aircraft: live, vehicles: [] }, map: null }, 1).aircraft.map((a) => ("vrate" in a ? a.vrate : "absent"));

  it("passes climbing, descending, null, absent and malformed values", () => {
    expect(vrates([plane("a", 1, { vertical_fpm: 1800 })])).toEqual([1800]);
    expect(vrates([plane("a", 1, { vertical_fpm: -900 })])).toEqual([-900]);
    expect(vrates([plane("a", 1, { vertical_fpm: null })])).toEqual([null]);
    expect(vrates([plane("a", 1)])).toEqual(["absent"]);
    expect(vrates([plane("a", 1, { vertical_fpm: "fast" })])).toEqual(["absent"]);
  });

  it("takes the live value when the receiver gives none, and the receiver's first otherwise", () => {
    expect(vrates([plane("a", 1)], [plane("a", 1, { vertical_fpm: 500 })])).toEqual([500]);
    expect(vrates([plane("a", 1, { vertical_fpm: 700 })], [plane("a", 1, { vertical_fpm: 500 })])).toEqual([700]);
  });
});
