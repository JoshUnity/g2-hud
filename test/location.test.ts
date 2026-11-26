import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOVE_M, REPEAT_MS, startLocation, type LocationBridge } from "../src/core/location";
import type { ClientMessage } from "../src/core/protocol";

type Fix = { latitude: number; longitude: number; accuracy?: number } | null;

/** A fake bridge: `once` answers getAppLocation, `push` plays a host update. */
function fakes() {
  let handler: ((f: NonNullable<Fix>) => void) | null = null;
  const state = { once: null as Fix | Error, started: 0, stopped: 0, unsubscribed: 0, startError: null as Error | null };
  const bridge = {
    getAppLocation: vi.fn(async () => {
      if (state.once instanceof Error) throw state.once;
      return state.once;
    }),
    startAppLocationUpdates: vi.fn(async () => {
      state.started++;
      if (state.startError) throw state.startError;
      return true;
    }),
    stopAppLocationUpdates: vi.fn(async () => {
      state.stopped++;
      return true;
    }),
    onAppLocationChanged: vi.fn((cb: (f: NonNullable<Fix>) => void) => {
      handler = cb;
      return () => {
        state.unsubscribed++;
        handler = null;
      };
    }),
  } as unknown as LocationBridge;
  const sent: ClientMessage[] = [];
  const conn = { open: true };
  const link = { send: (m: ClientMessage) => void sent.push(m), isOpen: () => conn.open };
  return { bridge, link, sent, conn, state, push: (f: NonNullable<Fix>) => handler?.(f) };
}

/** A point `metres` due north of (52, 5). */
const north = (metres: number) => ({ latitude: 52 + metres / 111_195, longitude: 5, accuracy: 8 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startLocation", () => {
  it("sends the first fix with its accuracy", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5, accuracy: 8 };
    startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent).toEqual([{ type: "position", lat: 52, lon: 5, accuracy: 8 }]);
    expect(f.state.started).toBe(1);
  });

  it("does not send a 10 m move, and sends a 30 m move", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5 };
    startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent).toHaveLength(1);
    f.push(north(10));
    expect(f.sent).toHaveLength(1);
    f.push(north(MOVE_M + 5));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ type: "position", lon: 5 });
  });

  it("sends the last fix again every 60 s", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5 };
    startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(f.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(f.sent).toHaveLength(3);
  });

  it("sends again after a reconnect, and holds a fix that arrives while the link is down", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5 };
    const r = startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    r.resend();
    expect(f.sent).toHaveLength(2);
    f.conn.open = false;
    f.push(north(100));
    expect(f.sent).toHaveLength(2);
    f.conn.open = true;
    r.resend();
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toMatchObject({ lat: expect.closeTo(52 + 100 / 111_195, 6) });
  });

  it("starts the updates again on rearm", async () => {
    const f = fakes();
    const r = startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    r.rearm();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.started).toBe(2);
    expect(f.bridge.onAppLocationChanged).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and does not throw for a null fix", async () => {
    const f = fakes();
    f.state.once = null;
    const r = startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    r.resend();
    r.rearm();
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(f.sent).toEqual([]);
  });

  it("sends nothing and does not throw when the permission is denied", async () => {
    const f = fakes();
    f.state.once = new Error("permission denied");
    f.state.startError = new Error("permission denied");
    const r = startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => r.rearm()).not.toThrow();
    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(f.sent).toEqual([]);
  });

  it("ignores a fix with bad coordinates", async () => {
    const f = fakes();
    f.state.once = { latitude: Number.NaN, longitude: 5 };
    startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    f.push({ latitude: 95, longitude: 5 });
    expect(f.sent).toEqual([]);
  });

  it("sends nothing after stop, and stops the host updates", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5 };
    const r = startLocation(f.bridge, f.link);
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    r.stop();
    f.push(north(500));
    r.resend();
    r.rearm();
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 3);
    expect(f.sent).toHaveLength(1);
    expect(f.state.unsubscribed).toBe(1);
    expect(f.state.stopped).toBe(1);
  });

  it("does not send a fix that was pending when stop ran", async () => {
    const f = fakes();
    f.state.once = { latitude: 52, longitude: 5 };
    const r = startLocation(f.bridge, f.link);
    r.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent).toEqual([]);
  });
});

describe("pages", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.doUnmock("../src/core/location");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function boot(app: "around" | "sky", search: string) {
    vi.resetModules();
    vi.stubGlobal("location", { search, protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null, createElement: () => ({}), body: { prepend: () => {} } });
    const started = vi.fn(() => ({ resend: vi.fn(), rearm: vi.fn(), stop: vi.fn() }));
    vi.doMock("../src/core/location", () => ({ startLocation: started }));
    vi.doMock("../src/core/net", () => ({
      connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => true, close: () => {} }),
    }));
    const bridge = {
      createStartUpPageContainer: async () => 0,
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      onEvenHubEvent: () => () => {},
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({ ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()), waitForEvenAppBridge: async () => bridge }));
    await import(`../src/${app}/main`);
    await vi.advanceTimersByTimeAsync(50);
    return started;
  }

  it.each(["around", "sky"] as const)("%s starts location in live mode only", async (app) => {
    expect(await boot(app, "?k=key&intro=0")).toHaveBeenCalledTimes(1);
    expect(await boot(app, "?k=key&intro=0&demo=1")).not.toHaveBeenCalled();
  });
});
