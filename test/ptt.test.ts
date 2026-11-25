import { OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS as CODE_SERVER_LIMIT } from "../server/codesession";
import { MAX_RECORDING_MS as HACK_SERVER_LIMIT } from "../server/hackos";
import { BODY as CARD } from "../src/core/hud";
import { HOLD_DROPPED_NOTE, HOLD_LIMIT_NOTE, MAX_HOLD_MS } from "../src/code/view";
import { LENS_TILES, lensCanvas } from "../src/core/board";
import { calibrate } from "../src/core/calibrate";
import { renderCodeLens } from "../src/code/lens";
import { buildLens, liveInput } from "../src/code/model";
import { codeScreen } from "../src/code/view";
import type { CodeView, HackView } from "../src/core/protocol";
import { crop } from "./board/compare";

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
  producers: [] as { box: { name: string }; render: (t: number) => Uint8Array }[],
  pipeBridge: null as { updateImageRawData: (u: unknown) => Promise<string> } | null,
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
  /** Behaves like the pipe: it renders each producer, sends a frame that changed through the bridge, one at a time. */
  ImagePipe: class {
    private last = new Map<string, Uint8Array>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private busy: Promise<void> = Promise.resolve();
    constructor(private bridge: { updateImageRawData: (u: unknown) => Promise<string> }) {
      h.pipeBridge = bridge;
    }
    set(producers: typeof h.producers): void {
      h.producers = producers;
      this.last.clear();
      void this.sendAll();
    }
    /** Renders every producer and sends what changed; resolves when the sends are done. */
    sendAll(): Promise<void> {
      this.busy = this.busy.then(async () => {
        for (const p of h.producers) {
          let frame: Uint8Array;
          try {
            frame = p.render(performance.now() / 1000);
          } catch {
            continue;
          }
          const held = this.last.get(p.box.name);
          if (held && held.length === frame.length && held.every((v, i) => v === frame[i])) continue;
          const result = await this.bridge.updateImageRawData({ containerName: p.box.name, imageData: frame });
          if (result === "success") this.last.set(p.box.name, frame);
        }
      });
      return this.busy;
    }
    poke(): void {}
    settled(): Promise<void> {
      return this.busy;
    }
    async run(): Promise<void> {
      this.timer = setInterval(() => void this.sendAll(), 250);
    }
    stop(): void {
      h.pipeStops++;
      if (this.timer) clearInterval(this.timer);
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
    /** The next upgrades of the container with this name are refused (return false). */
    refuse: "" as string,
    /** What each text container holds now, by name (from the page and from upgrades). */
    contents: {} as Record<string, string>,
    /** The image sends of these tiles fail, by name. */
    failTiles: new Set<string>(),
    updateImageRawData: async (u: { containerName?: string }) => (host.failTiles.has(u.containerName ?? "") ? "sendFailed" : "success"),
    /** An upgrade of the container with this name takes this long (ms), every time. */
    holdCall: 0,
    /** The upgrades by container name, in order. */
    upgrades: [] as [string, string][],
    textContainerUpgrade: async (u: { containerName?: string; content?: string }) => {
      host.texts.push(u.content ?? "");
      host.upgrades.push([u.containerName ?? "", u.content ?? ""]);
      if (!(host.refuse && u.containerName === host.refuse) && !(host.holdCall && u.containerName === "call")) host.contents[u.containerName ?? ""] = u.content ?? "";
      if (host.refuse && u.containerName === host.refuse) return false;
      if (host.holdCall && u.containerName === "call") {
        await new Promise((resolve) => setTimeout(resolve, host.holdCall));
        host.contents[u.containerName] = u.content ?? "";
        return true;
      }
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
    /** The names of the containers of every page rebuilt, in order. */
    pages: [] as string[][],
    /** The next rebuilds fail. */
    failRebuild: false,
    /** The next rebuild takes this long (ms). */
    slowRebuild: 0,
    rebuildPageContainer: async (page: { textObject?: { content?: string; containerName?: string }[] }) => {
      if (host.slowRebuild) {
        const ms = host.slowRebuild;
        host.slowRebuild = 0;
        host.pages.push((page.textObject ?? []).map((t) => t.containerName ?? ""));
        await new Promise((resolve) => setTimeout(resolve, ms));
        return true;
      }
      host.pages.push((page.textObject ?? []).map((t) => t.containerName ?? ""));
      if (host.failRebuild) return false;
      for (const t of page.textObject ?? []) host.contents[t.containerName ?? ""] = t.content ?? "";
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
  h.producers = [];
  windowListeners.clear();
  host = fakeHost();
  h.bridge = host;
  vi.stubGlobal("document", {
    getElementById: () => null,
    addEventListener: () => {},
    activeElement: null,
  });
  vi.stubGlobal("location", { search: "?k=key&intro=0", protocol: "http:", host: "localhost" });
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
      const sent = host.texts.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.texts.length).toBe(sent);
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

describe("code approval pages", () => {
  const view = (state: CodeView["state"], text = "$ ls", id = 1): CodeView => ({
    ...codeView,
    state,
    approval: state === "approval" ? { id, summary: text, text } : null,
  });
  const show = (v: CodeView) => h.onMessage?.({ type: "code", data: { error: "", tabs: [{ id: 1, view: v }] } });
  const decides = () => h.sent.filter((m) => m.type === "code_decide");
  const tap = async () => {
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(600);
  };
  beforeEach(async () => {
    await load("code");
  });

  const callUpgrades = () => host.upgrades.filter(([name]) => name === "call").map(([, text]) => text);

  it("does not rebuild the page for an approval: the call goes to its text container, and goes away again", async () => {
    show(view("working")); // the first hub message builds the tab menu
    await vi.advanceTimersByTimeAsync(300);
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(300);
    expect(host.pages).toHaveLength(1); // the request is no rebuild
    expect(callUpgrades()).toEqual(["$ ls"]);
    show(view("working"));
    await vi.advanceTimersByTimeAsync(300);
    expect(host.pages).toHaveLength(1);
    expect(callUpgrades()).toEqual(["$ ls", ""]);
  });

  it("never allows a request whose call text the glasses did not accept, however long it waits", async () => {
    show(view("working"));
    await vi.advanceTimersByTimeAsync(300);
    host.refuse = "call";
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(5000);
    await tap();
    expect(decides()).toEqual([]);
    host.refuse = "";
    show(view("approval")); // a pass runs now and the call is accepted
    await vi.advanceTimersByTimeAsync(250);
    await tap();
    expect(decides()).toEqual([]); // 0.7 s on the lens has not passed since it was accepted
    await vi.advanceTimersByTimeAsync(1000);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("starts the 0.7 s over when the page is rebuilt, and cancels a tap that is waiting", async () => {
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(1500);
    sys(OsEventTypeList.CLICK_EVENT); // pending for 0.4 s
    h.onMessage?.({ type: "code", data: { error: "", tabs: [{ id: 1, view: view("approval") }, { id: 2, view: view("idle") }] } }); // the tab menu changed: rebuild
    await vi.advanceTimersByTimeAsync(600);
    expect(decides()).toEqual([]);
  });

  it("does not allow on the first page of a long call", async () => {
    show(view("approval", Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"))); // 6 pages of 2 lines
    await vi.advanceTimersByTimeAsync(1500);
    await tap();
    expect(decides()).toEqual([]);
    for (let i = 0; i < 5; i++) {
      sys(OsEventTypeList.SCROLL_BOTTOM_EVENT);
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(900);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("shows an approval at once while the map is still mounting", async () => {
    const tree = [{ name: "src", files: 10 }];
    show({ ...view("working"), tree });
    await vi.advanceTimersByTimeAsync(300); // the mount has just started
    show({ ...view("approval"), tree });
    await vi.advanceTimersByTimeAsync(300);
    expect(callUpgrades().at(-1)).toBe("$ ls");
    await vi.advanceTimersByTimeAsync(1000);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const tabs = (...entries: [number, CodeView][]) => h.onMessage?.({ type: "code", data: { error: "", tabs: entries.map(([id, v]) => ({ id, view: v })) } });

  it("does not carry the page of a closed tab over to another tab's request with the same id", async () => {
    tabs([1, view("approval", long)], [2, view("approval", long)]);
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 5; i++) {
      sys(OsEventTypeList.SCROLL_BOTTOM_EVENT);
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(1000);
    tabs([2, view("approval", long)]); // tab 1 is closed: tab 2 (request id 1 too) is shown
    await vi.advanceTimersByTimeAsync(2000);
    await tap();
    expect(decides()).toEqual([]); // its first page is on the lens, not its last
    for (let i = 0; i < 5; i++) {
      sys(OsEventTypeList.SCROLL_BOTTOM_EVENT);
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(1000);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 2, id: 1, allow: true }]);
  });

  it("never allows while the page for the current tab menu was not rebuilt, even though the old page is there", async () => {
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(1500);
    host.failRebuild = true;
    tabs([1, view("approval")], [2, view("idle")]); // the menu changed: a rebuild that fails
    await vi.advanceTimersByTimeAsync(1500);
    await tap();
    expect(decides()).toEqual([]);
    host.failRebuild = false;
    await vi.advanceTimersByTimeAsync(3000);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("keeps counting the bar from the first arrival across a reconnect", async () => {
    const t0 = Date.now();
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(30_000);
    h.onConnected?.(false);
    h.onConnected?.(true);
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(400);
    // The bar and its time are in the bottom right tile of the lens raster.
    const tile = h.producers.find((p) => p.box.name === "t11");
    expect(tile).toBeDefined();
    const left = Math.floor((120_000 - (Date.now() - t0)) / 1000);
    expect(left).toBeLessThan(90);
    const screen = codeScreen(view("approval"), 0, new Date(), [], "", 1);
    const canvas = lensCanvas();
    renderCodeLens(canvas, buildLens(screen, view("approval"), [], { clock: "00:00", level: 0, elapsedMs: 0, remaining: left }), 0);
    expect(tile?.render(0)).toEqual(crop(calibrate(canvas.pixels), 576, { x: 288, y: 144, width: 288, height: 144 }));
  });

  it("sends a stop on a double tap right after the request was resolved, not a deny of the old request", async () => {
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(1500);
    show(view("working")); // resolved on the phone; the page has not drawn it yet
    sys(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(h.sent.filter((m) => m.type === "code_stop")).toEqual([{ type: "code_stop", tab: 1 }]);
    expect(decides()).toEqual([]);
  });

  it("sends nothing to the glasses after an exit during a slow rebuild", async () => {
    host.slowRebuild = 3000;
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(400); // the rebuild is in flight
    sys(OsEventTypeList.SYSTEM_EXIT_EVENT);
    const texts = host.texts.length;
    const pages = host.pages.length;
    show(view("working"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.texts.length).toBe(texts);
    expect(host.pages.length).toBe(pages);
  });

  const lastPage = async (n = 5) => {
    for (let i = 0; i < n; i++) {
      sys(OsEventTypeList.SCROLL_BOTTOM_EVENT);
      await vi.advanceTimersByTimeAsync(300);
    }
  };
  const longCall = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"); // 6 pages of 2 lines

  it("does not let a pass that was in flight across a reconnect bring back an old approval when ids restart (same id, new text)", async () => {
    show(view("working"));
    await vi.advanceTimersByTimeAsync(300);
    host.holdCall = 3000; // the glasses answer the call update slowly
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(500); // a pass waits on that update
    h.onConnected?.(false);
    h.onConnected?.(true);
    show(view("approval", "$ rm -rf B", 1)); // the server restarted: id 1 again, another call
    await vi.advanceTimersByTimeAsync(4000); // the old pass ends; the new call is still not accepted
    await tap();
    expect(decides()).toEqual([]);
  });

  it("does not allow on the last page while the pass that sends an earlier page is still pending (scroll up, then down)", async () => {
    show(view("approval", longCall));
    await vi.advanceTimersByTimeAsync(1500);
    await lastPage();
    await vi.advanceTimersByTimeAsync(1500); // the last page is accepted and has been on for long enough
    host.holdCall = 3000;
    sys(OsEventTypeList.SCROLL_TOP_EVENT);
    await vi.advanceTimersByTimeAsync(300); // the pass that sends page 5 waits
    sys(OsEventTypeList.SCROLL_BOTTOM_EVENT); // back on the last page, whose text is not accepted again yet
    await vi.advanceTimersByTimeAsync(100);
    await tap();
    expect(decides()).toEqual([]);
  });

  it("denies a request on show whose text the glasses have not accepted yet (a deny is always safe)", async () => {
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(1500);
    host.holdCall = 3000;
    show(view("approval", "$ ls B", 2)); // B's card is drawn; its text is still on its way
    await vi.advanceTimersByTimeAsync(400);
    sys(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 2, allow: false }]);
  });

  it("blocks an allow while a tile of the card was not accepted, until a later send succeeds", async () => {
    show(view("working"));
    await vi.advanceTimersByTimeAsync(600);
    host.failTiles.add("t01"); // part of the card (the bottom left of the lens) cannot be sent
    show(view("approval", "$ ls", 1));
    await vi.advanceTimersByTimeAsync(3000);
    await tap();
    expect(decides()).toEqual([]);
    host.failTiles.clear();
    await vi.advanceTimersByTimeAsync(1500); // the pipe sends the changed tile again
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("counts the bar again from the arrival when a restarted server reuses an id for another call", async () => {
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(30_000);
    h.onConnected?.(false);
    h.onConnected?.(true);
    const arrived = Date.now();
    show(view("approval", "$ ls B", 1));
    await vi.advanceTimersByTimeAsync(400);
    const tile = h.producers.find((p) => p.box.name === "t11");
    const left = Math.floor((120_000 - (Date.now() - arrived)) / 1000);
    expect(left).toBeGreaterThan(115);
    const request = view("approval", "$ ls B", 1);
    const canvas = lensCanvas();
    renderCodeLens(canvas, buildLens(codeScreen(request, 0, new Date(), [], "", 1), request, [], { clock: "00:00", level: 0, elapsedMs: 0, remaining: left }), 0);
    expect(tile?.render(0)).toEqual(crop(calibrate(canvas.pixels), 576, { x: 288, y: 144, width: 288, height: 144 }));
  });

  it("sends nothing for the old request or the new one when the request is replaced during the 0.4 s before the allow", async () => {
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(1500);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(200);
    show(view("approval", "$ rm -rf B", 2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(decides()).toEqual([]);
  });

  it("sends nothing when the tab changes during the 0.4 s before the allow", async () => {
    tabs([1, view("approval", "$ ls A", 1)], [2, view("idle")]);
    await vi.advanceTimersByTimeAsync(1500);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(100);
    host.handler?.({ menuItemClickEvent: { itemID: 2 } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(decides()).toEqual([]);
  });

  it("denies, and cancels the allow, on a double tap while an allow is pending", async () => {
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(1500);
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(100);
    sys(OsEventTypeList.DOUBLE_CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(1500);
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: false }]);
  });

  it("allows only 0.7 s after a text update that was pending for a long time was accepted", async () => {
    show(view("working"));
    await vi.advanceTimersByTimeAsync(300);
    host.holdCall = 3000;
    show(view("approval", "$ ls A", 1));
    await vi.advanceTimersByTimeAsync(3300); // accepted about 150 ms ago
    sys(OsEventTypeList.CLICK_EVENT);
    await vi.advanceTimersByTimeAsync(600);
    expect(decides()).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    await tap();
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: true }]);
  });

  it("denies at once on a double tap", async () => {
    show(view("approval"));
    await vi.advanceTimersByTimeAsync(300);
    sys(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(decides()).toEqual([{ type: "code_decide", tab: 1, id: 1, allow: false }]);
  });
});

describe("code page from real protocol messages (no demo scene)", () => {
  const tabsOf = (v: CodeView) => ({ type: "code", data: { error: "", tabs: [{ id: 1, view: v }] } });
  const tree = ["src", "server", "test", "apps"].map((name) => ({ name, files: 12 }));
  const working = (): CodeView => ({
    ...codeView,
    state: "working",
    prompt: "Add a dark mode toggle to the settings page",
    log: ["› Read src/settings/page.tsx", "› Edit src/settings/page.tsx", "› $ npm test"],
    startedAt: Date.now() - 15_000,
    tree,
    files: [
      { path: "src/settings/page.tsx", state: "edit" },
      { path: "src/theme.ts", state: "read" },
      { path: "test/page.test.ts", state: "read" },
    ],
    current: "test/page.test.ts",
    added: 42,
    removed: 7,
  });
  /** The lens the page should send for this input, cut into its four tiles. */
  const expectedTiles = (view: CodeView, arrivedAt: number | undefined, t: number) => {
    const screen = codeScreen(view, 0, new Date(), [], "", 1);
    const canvas = lensCanvas();
    renderCodeLens(canvas, buildLens(screen, view, [], liveInput(view, arrivedAt, Date.now(), 0)), t, 1);
    const sent = calibrate(canvas.pixels);
    return LENS_TILES.map((b) => crop(sent, 576, b));
  };
  const tiles = (t: number) => LENS_TILES.map((b) => h.producers.find((p) => p.box.name === b.name)!.render(t));

  beforeEach(async () => {
    vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
    await load("code");
  });

  it("shows a working view: the board's texts, and tiles equal to the renderer's frame for that input", async () => {
    const view = working();
    h.onMessage?.(tabsOf(view));
    await vi.advanceTimersByTimeAsync(400);
    expect(host.contents).toMatchObject({
      status: "Working",
      prompt: "“Add a dark mode toggle to the\nsettings page”",
      steps: "Read src/settings/page.tsx\nEdit src/settings/page.tsx",
      step: "\n\n$ npm test",
      call: "",
      hint: "",
      body: "",
    });
    expect(tiles(1.25)).toEqual(expectedTiles(view, undefined, 1.25));
  });

  it("shows an approval: the call in full, the folder line, the hint, and the card's tiles for that input", async () => {
    h.onMessage?.(tabsOf(working()));
    await vi.advanceTimersByTimeAsync(300);
    const approval = { id: 1, summary: "$ npm install @evenrealities/pretext", text: "$ npm install @evenrealities/pretext", tool: "BASH", cwd: "~/Desktop/g2-hud", network: true };
    const view: CodeView = { ...working(), state: "approval", prompt: "Install the font measurement library", approval };
    const arrivedAt = Date.now();
    h.onMessage?.(tabsOf(view));
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.contents).toMatchObject({
      status: "Allow?",
      prompt: "“Install the font measurement library”",
      call: "$ npm install @evenrealities/pretext",
      folder: "in ~/Desktop/g2-hud",
      hint: "Tap allow  ·  Double tap deny",
      steps: "",
      step: "",
    });
    expect(tiles(1.25)).toEqual(expectedTiles(view, arrivedAt, 1.25));
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
