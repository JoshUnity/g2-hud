import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenFeed, chooseFeed, type Feed } from "../server/open/select";
import { OpenFeed } from "../server/open/feed";
import { fakeFetch, ok } from "./openkit";

const stubFeed = (): Feed => ({ start: vi.fn(), stop: vi.fn(), latest: null, latestMap: () => null });
afterEach(() => vi.unstubAllGlobals());

describe("which feed runs", () => {
  it("LOOPS_SSH set: Loops runs, the open feed is never constructed, and a position message reaches no network and no log", () => {
    // Two traps: the injected fetch, and the global one the real feed would use.
    const trap = fakeFetch(() => ok({}));
    vi.stubGlobal("fetch", trap);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const makeOpen = vi.fn(() => new OpenFeed({ aircraft: undefined as never, map: null, incidents: null, active: () => true }, () => undefined, () => undefined));
    const loops = stubFeed();
    const makeLoops = vi.fn(() => loops);

    const choice = chooseFeed({ LOOPS_SSH: "pi@raspberrypi.local", HUD_LAT: "52.1", HUD_LON: "4.1" }, { loops: makeLoops, open: makeOpen });
    choice.feed!.start();
    // What the server does with a client's { type: "position" } message.
    choice.position({ lat: 52.3791, lon: 4.9003, accuracy: 12 });
    choice.position({ lat: 48.8566, lon: 2.3522 });

    expect(choice.kind).toBe("loops");
    expect(choice.feed).toBe(loops);
    expect(makeLoops).toHaveBeenCalledWith("pi@raspberrypi.local");
    expect(makeOpen).not.toHaveBeenCalled();
    expect(trap.calls).toHaveLength(0);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("the server routes a position message only to that function, and never logs it", () => {
    const source = readFileSync(`${import.meta.dirname}/../server/index.ts`, "utf8");
    const block = source.slice(source.indexOf('case "position"'), source.indexOf("default:", source.indexOf('case "position"')));
    expect(block).toContain("feedChoice.position(parsed.data)");
    expect(block).not.toMatch(/log\.|console\./);
  });

  it("no LOOPS_SSH: the open feed runs and passes the position on", () => {
    const setPosition = vi.fn();
    const feed = { ...stubFeed(), setPosition };
    const choice = chooseFeed({}, { loops: () => stubFeed(), open: () => feed });
    choice.position({ lat: 1, lon: 2 });
    expect(choice.kind).toBe("open");
    expect(setPosition).toHaveBeenCalledWith({ lat: 1, lon: 2 });
  });

  it("OPEN_FEED=off: no feed at all", () => {
    const open = vi.fn();
    const choice = chooseFeed({ OPEN_FEED: "off" }, { loops: () => stubFeed(), open: open as never });
    expect(choice.kind).toBe("off");
    expect(choice.feed).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("OPEN_FEED=off does not turn Loops off", () => {
    expect(chooseFeed({ OPEN_FEED: "off", LOOPS_SSH: "pi@host" }, { loops: () => stubFeed(), open: vi.fn() as never }).kind).toBe("loops");
  });
});

describe("the open feed from the environment", () => {
  it("builds with its defaults without starting any request", () => {
    const f = fakeFetch(() => ok({}));
    buildOpenFeed({ HUD_LAT: "52.1", HUD_LON: "4.1", AIRCRAFT_SOURCE: "off" }, { active: () => true, onUpdate: () => undefined, onMap: () => undefined }, f, "/nonexistent");
    expect(f.calls).toHaveLength(0);
  });

  it("uses HUD_LAT and HUD_LON, and ignores bad ones", () => {
    const make = (env: Record<string, string>) => buildOpenFeed(env, { active: () => true, onUpdate: () => undefined, onMap: () => undefined }, fakeFetch(() => ok({})), "/nonexistent");
    expect(make({ HUD_LAT: "52.1", HUD_LON: "4.1" }).latest.me).toMatchObject({ lat: 52.1, lon: 4.1, source: "home" });
    expect(make({ HUD_LAT: "abc", HUD_LON: "4.1" }).latest.me).toBeNull();
    expect(make({ HUD_LAT: "99", HUD_LON: "4.1" }).latest.me).toBeNull();
    expect(make({}).latest.me).toBeNull();
  });
});

describe("Loops mode output", () => {
  it("toOsint never sets aircraftSource", async () => {
    const { toOsint } = await import("../server/loops");
    const osint = toOsint({ location: { fix: { lat: 1, lon: 1 } }, items: [], aircraft: { aircraft: [] }, live: { aircraft: [], vehicles: [] }, map: null }, 1);
    expect("aircraftSource" in osint).toBe(false);
  });
});
