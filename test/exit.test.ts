import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onExit } from "../src/core/events";

const exit = (eventType: OsEventTypeList) => ({ sysEvent: { eventType } }) as EvenHubEvent;

describe("onExit", () => {
  it("calls once on a system or abnormal exit, ignores other events, and unsubscribes", () => {
    const listeners = new Set<(e: EvenHubEvent) => void>();
    const bridge = { onEvenHubEvent: (fn: (e: EvenHubEvent) => void) => (listeners.add(fn), () => listeners.delete(fn)) };
    const fn = vi.fn();
    const off = onExit(bridge as never, fn);
    for (const l of listeners) l(exit(OsEventTypeList.FOREGROUND_EXIT_EVENT));
    for (const l of listeners) l({ sysEvent: {} } as EvenHubEvent);
    expect(fn).not.toHaveBeenCalled();
    for (const l of listeners) l(exit(OsEventTypeList.ABNORMAL_EXIT_EVENT));
    for (const l of listeners) l(exit(OsEventTypeList.SYSTEM_EXIT_EVENT));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe("an exit before the page exists", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Boots an app against a bridge whose page creation waits for `release()`. Records every send with its order. */
  async function boot(app: string, search: string) {
    vi.resetModules();
    vi.stubGlobal("location", { search, protocol: "http:", host: "localhost" });
    const element = { style: {}, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {}, append: () => {}, textContent: "" };
    vi.stubGlobal("document", { getElementById: () => null, addEventListener: () => {}, createElement: () => element, body: { prepend: () => {} }, activeElement: null });
    vi.stubGlobal("window", { addEventListener: () => {} });
    const close = vi.fn();
    vi.doMock("../src/core/net", () => ({
      connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => false, close }),
      MISSING_KEY_MESSAGE: "No pairing key.",
    }));
    const sends: string[] = [];
    const listeners = new Set<(e: EvenHubEvent) => void>();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let created = 0;
    const bridge = {
      createStartUpPageContainer: async () => {
        sends.push("create");
        // The first create is the app's page; with the intro on, the splash's create is not held.
        if (search.includes("intro=0") || created++ > 0) await gate;
        return StartUpPageCreateResult.success;
      },
      rebuildPageContainer: async () => (sends.push("rebuild"), true),
      textContainerUpgrade: async () => (sends.push("text"), true),
      updateImageRawData: async () => (sends.push("image"), 0),
      audioControl: async (on: boolean) => (sends.push(on ? "mic-on" : "mic-off"), true),
      onEvenHubEvent: (fn: (e: EvenHubEvent) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import(`../src/${app}/main.ts`);
    await vi.waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    return {
      sends,
      close,
      listeners,
      release,
      exit: () => {
        for (const l of [...listeners]) l(exit(OsEventTypeList.SYSTEM_EXIT_EVENT));
        return sends.length;
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const forbidden = (sends: string[], from: number) => sends.slice(from).filter((s) => s !== "mic-off" && s !== "create");

  for (const app of ["answers", "hackos", "around", "sky"]) {
    it(`${app}: an exit while the page is created shuts down, and nothing is sent afterwards`, async () => {
      const t = await boot(app, "?k=key&intro=0&load=off");
      await vi.waitFor(() => expect(t.sends).toContain("create"));
      const at = t.exit();
      t.release();
      await settle();
      expect(forbidden(t.sends, at)).toEqual([]);
      expect(t.sends).not.toContain("mic-on");
      expect(t.close).toHaveBeenCalledTimes(1);
      expect(t.listeners.size).toBe(0);
    });

    it(`${app}: an exit during the intro shuts down, and nothing is sent afterwards`, async () => {
      const t = await boot(app, "?k=key&load=off");
      await vi.waitFor(() => expect(t.sends).toContain("create"));
      const at = t.exit();
      t.release();
      await settle();
      expect(forbidden(t.sends, at)).toEqual([]);
      expect(t.sends).not.toContain("mic-on");
      expect(t.close).toHaveBeenCalledTimes(1);
    });
  }
});
