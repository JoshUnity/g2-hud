import { OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS as CODE_SERVER_LIMIT } from "../server/codesession";
import { MAX_RECORDING_MS as HACK_SERVER_LIMIT } from "../server/hackos";
import { CARD } from "../src/answers/hud";
import { HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS } from "../src/code/view";
import type { CodeView, HackView } from "../src/core/protocol";

/**
 * The real Code and HackOS pages (src/code/main.ts, src/hackos/main.ts) with a stand-in Even
 * host, a stand-in server connection and a minimal DOM. Fake timers drive the hold limit.
 */

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("the Agent SDK must not run in tests");
  }),
}));

const h = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  frames: 0,
  closed: 0,
  pipeStops: 0,
  onMessage: null as ((message: unknown) => void) | null,
  onConnected: null as ((connected: boolean) => void) | null,
  bridge: null as unknown,
}));

vi.mock("../src/core/net", () => ({
  connectServer: (onMessage: (message: unknown) => void, onConnected: (connected: boolean) => void) => {
    h.onMessage = onMessage;
    h.onConnected = onConnected;
    return {
      send: (message: Record<string, unknown>) => h.sent.push(message),
      sendBinary: () => h.frames++,
      isOpen: () => true,
      close: () => h.closed++,
    };
  },
}));
vi.mock("../src/core/page", () => ({ openPage: async () => true, notePageFailure: () => {} }));
vi.mock("../src/core/imagepipe", () => ({
  ImagePipe: class {
    set(): void {}
    async run(): Promise<void> {}
    stop(): void {
      h.pipeStops++;
    }
  },
}));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => h.bridge,
}));

type Handler = (event: object) => void;

function fakeHost() {
  const host = {
    handler: null as Handler | null,
    /** Every text sent to the glasses, by an update or a rebuild. */
    texts: [] as string[],
    /** The card texts sent by updates, in the order they were sent. */
    cards: [] as string[],
    /** The next update takes this long (ms). */
    slow: 0,
    /** The next update fails. */
    failNext: false,
    audioControl: vi.fn(async (_on: boolean) => true),
    onEvenHubEvent(fn: Handler) {
      host.handler = fn;
      return () => {
        host.handler = null;
      };
    },
    textContainerUpgrade: async (u: { containerName?: string; content?: string }) => {
      host.texts.push(u.content ?? "");
      if (u.containerName === CARD.name) host.cards.push(u.content ?? "");
      if (host.failNext) {
        host.failNext = false;
        throw new Error("the host refused the update");
      }
      const ms = host.slow;
      host.slow = 0;
      if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
      return true;
    },
    rebuildPageContainer: async (page: { textObject?: { content?: string }[] }) => {
      for (const t of page.textObject ?? []) host.texts.push(t.content ?? "");
      return true;
    },
    createStartUpPageContainer: async () => 0,
  };
  return host;
}

let host: ReturnType<typeof fakeHost>;
const windowListeners = new Map<string, () => void>();

const sys = (eventType: OsEventTypeList) => host.handler?.({ sysEvent: { eventType } });
const audio = () => host.handler?.({ audioEvent: { audioPcm: new Uint8Array(320), speakerRole: 0 } });
const ptts = () => h.sent.filter((m) => m.type === "code_ptt" || m.type === "hack_ptt").map(({ on, discard }) => ({ on, discard }));
const audioCalls = () => host.audioControl.mock.calls.map((c) => c[0]);

async function load(app: "code" | "hackos"): Promise<void> {
  if (app === "code") await import("../src/code/main");
  else await import("../src/hackos/main");
  await vi.advanceTimersByTimeAsync(0);
  expect(host.handler).not.toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  h.sent.length = 0;
  h.frames = 0;
  h.closed = 0;
  h.pipeStops = 0;
  windowListeners.clear();
  host = fakeHost();
  h.bridge = host;
  vi.stubGlobal("document", {
    getElementById: () => null,
    addEventListener: () => {},
    activeElement: null,
  });
  vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => windowListeners.set(type, fn) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stops the page before the server: the hold limit is below the server's recording limit", () => {
  expect(MAX_HOLD_MS).toBeLessThan(CODE_SERVER_LIMIT);
  expect(MAX_HOLD_MS).toBeLessThan(HACK_SERVER_LIMIT);
});

const codeView: CodeView = { state: "idle", project: "g2-hud", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
const hackView: HackView = { state: "idle", model: "m", prompt: "", answer: "", stats: "", error: "", startedAt: null, history: [] };

for (const app of ["code", "hackos"] as const) {
  const show = (state: CodeView["state"] & HackView["state"], error = "") =>
    h.onMessage?.(
      app === "code"
        ? { type: "code", data: { error: "", tabs: [{ id: 1, view: { ...codeView, state, error } }] } }
        : { type: "hack", data: { ...hackView, state, error } },
    );

  describe(`${app} push-to-talk`, () => {
    beforeEach(async () => {
      await load(app);
      show("idle");
    });

    it("runs what was heard on a release, as before", async () => {
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      sys(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      expect(ptts()).toEqual([{ on: true, discard: undefined }, { on: false, discard: undefined }]);
      expect(audioCalls()).toEqual([true, false]);
    });

    it("ends a hold whose release never comes after MAX_HOLD_MS, closes the microphone and sends nothing", async () => {
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      show("recording"); // the server's answer to the press
      audio();
      expect(h.frames).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS);
      expect(ptts()).toEqual([{ on: true, discard: undefined }, { on: false, discard: true }]);
      expect(audioCalls()).toEqual([true, false]);
      audio();
      expect(h.frames).toBe(1); // no audio goes out after the stop
      // The note shows on the glasses, and stays when the server leaves "recording".
      show("idle", "Recording stopped. Nothing was sent. Hold and speak again.");
      await vi.advanceTimersByTimeAsync(1200);
      expect(host.texts.some((t) => t.replace(/\n/g, " ").includes(HOLD_LIMIT_NOTE))).toBe(true);
      expect(host.texts.at(-1)).not.toBe("");
    });

    it("drops the hold when the system menu opens or closes, and only while holding", async () => {
      sys(OsEventTypeList.FOREGROUND_EXIT_EVENT);
      sys(OsEventTypeList.FOREGROUND_ENTER_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      expect(ptts()).toEqual([]);
      for (const exit of [OsEventTypeList.FOREGROUND_ENTER_EVENT, OsEventTypeList.FOREGROUND_EXIT_EVENT]) {
        h.sent.length = 0;
        host.audioControl.mockClear();
        sys(OsEventTypeList.LONG_PRESS_EVENT);
        await vi.advanceTimersByTimeAsync(0);
        sys(exit);
        await vi.advanceTimersByTimeAsync(0);
        expect(ptts(), String(exit)).toEqual([{ on: true, discard: undefined }, { on: false, discard: true }]);
        expect(audioCalls()).toEqual([true, false]);
      }
      await vi.advanceTimersByTimeAsync(1200);
      expect(host.texts.some((t) => t.replace(/\n/g, " ").includes(HOLD_DROPPED_NOTE))).toBe(true);
      expect(h.closed).toBe(0); // the menu is not an exit: the page stays connected
    });

    for (const exit of [OsEventTypeList.ABNORMAL_EXIT_EVENT, OsEventTypeList.SYSTEM_EXIT_EVENT]) {
      it(`shuts down on exit event ${exit}: drops the hold, then stops listening, drawing and the connection`, async () => {
        sys(OsEventTypeList.LONG_PRESS_EVENT);
        await vi.advanceTimersByTimeAsync(0);
        sys(exit);
        await vi.advanceTimersByTimeAsync(0);
        expect(ptts()).toEqual([{ on: true, discard: undefined }, { on: false, discard: true }]);
        expect(audioCalls()).toEqual([true, false]);
        expect(h.closed).toBe(1);
        expect(h.pipeStops).toBe(1);
        expect(host.handler).toBeNull();
        // No more ticks or renders, even when a late message arrives.
        const drawn = host.texts.length;
        show("idle");
        await vi.advanceTimersByTimeAsync(5000);
        expect(host.texts.length).toBe(drawn);
      });
    }

    it("starts no further render pass after an exit while a pass is in flight", async () => {
      await vi.advanceTimersByTimeAsync(1200);
      host.slow = 3000;
      show("idle", "FIRST NOTE");
      await vi.advanceTimersByTimeAsync(500); // a pass waits on the slow write
      show("idle", "SECOND NOTE");
      await vi.advanceTimersByTimeAsync(200); // a render is asked for during that pass
      sys(OsEventTypeList.SYSTEM_EXIT_EVENT);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.texts.some((t) => t.includes("FIRST NOTE"))).toBe(true);
      expect(host.texts.some((t) => t.includes("SECOND NOTE"))).toBe(false);
    });

    it("refuses a press while the last hold is still transcribed (the server refuses it too)", async () => {
      show("transcribing");
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      expect(ptts()).toEqual([]);
      expect(audioCalls()).toEqual([]);
    });

    it("drops the hold when the connection or the page goes away", async () => {
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      h.onConnected?.(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(audioCalls()).toEqual([true, false]);
      expect(ptts().at(-1)).toEqual({ on: false, discard: true });
      h.onConnected?.(true);
      show("idle");
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      windowListeners.get("pagehide")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(audioCalls()).toEqual([true, false, true, false]);
      expect(ptts().at(-1)).toEqual({ on: false, discard: true });
    });

    it("starts over on a press while holding, and keeps the time limit from the new press", async () => {
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - 1000);
      sys(OsEventTypeList.LONG_PRESS_EVENT);
      await vi.advanceTimersByTimeAsync(2000);
      expect(ptts()).toEqual([{ on: true, discard: undefined }, { on: true, discard: undefined }]);
      sys(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
      await vi.advanceTimersByTimeAsync(0);
      expect(ptts().at(-1)).toEqual({ on: false, discard: undefined });
      expect(audioCalls()).toEqual([true, false]);
    });
  });
}

describe("code approval taps", () => {
  const approval = (id: number, text: string) =>
    h.onMessage?.({ type: "code", data: { error: "", tabs: [{ id: 1, view: { ...codeView, state: "approval", approval: { id, summary: text, text } } }] } });
  const decides = () => h.sent.filter((m) => m.type === "code_decide");
  beforeEach(async () => {
    await load("code");
  });

  it("allows with a tap once the card showed long enough", async () => {
    approval(1, "$ ls");
    await vi.advanceTimersByTimeAsync(1000);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(500);
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("does not count a card seen before the connection dropped for a new request with the same id", async () => {
    approval(1, "$ ls");
    await vi.advanceTimersByTimeAsync(1000);
    // The server restarted: its ids start from 1 again.
    h.onConnected?.(false);
    h.onConnected?.(true);
    approval(1, "$ rm -rf build");
    await vi.advanceTimersByTimeAsync(200);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(500);
    expect(decides()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(500);
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });
});

describe("hackos glasses page", () => {
  const answering = (answer: string) => h.onMessage?.({ type: "hack", data: { ...hackView, state: "answering", prompt: "q", answer } });
  beforeEach(async () => {
    await load("hackos");
    h.onMessage?.({ type: "hack", data: hackView });
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("never sends an older card after a newer one, even when a write is slow", async () => {
    host.slow = 600;
    answering("first part");
    await vi.advanceTimersByTimeAsync(200);
    answering("first part and the newest words");
    await vi.advanceTimersByTimeAsync(2000);
    const newest = host.cards.findIndex((c) => c.includes("newest words"));
    expect(newest).toBeGreaterThanOrEqual(0);
    expect(host.cards.slice(newest).every((c) => c.includes("newest words"))).toBe(true);
  });

  it("carries on with the other boxes after a write that fails", async () => {
    host.failNext = true;
    answering("hello there");
    await vi.advanceTimersByTimeAsync(160);
    expect(host.cards.at(-1)).toContain("hello there");
  });

  it("drops a microphone note when the connection drops", async () => {
    host.audioControl.mockResolvedValueOnce(false);
    sys(OsEventTypeList.LONG_PRESS_EVENT);
    await vi.advanceTimersByTimeAsync(300);
    expect(host.texts.some((t) => t.includes("microphone did not start"))).toBe(true);
    const from = host.texts.length;
    h.onConnected?.(false);
    await vi.advanceTimersByTimeAsync(300);
    h.onConnected?.(true);
    h.onMessage?.({ type: "hack", data: hackView });
    await vi.advanceTimersByTimeAsync(300);
    expect(host.texts.slice(from).some((t) => t.includes("microphone did not start"))).toBe(false);
  });
});
