import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_OSINT } from "../src/around/sample";

describe("Sky opening and emergencies", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** The text of the list container on the first page, with a live feed and the opening on. */
  async function firstList(emergency: boolean): Promise<string> {
    vi.resetModules();
    vi.stubGlobal("location", { search: "?k=key&intro=0", protocol: "http:", host: "localhost" });
    vi.stubGlobal("document", { getElementById: () => null });
    const data = { ...SAMPLE_OSINT, aircraft: SAMPLE_OSINT.aircraft.map((p, i) => (i === 3 ? { ...p, emergency } : p)) };
    vi.doMock("../src/core/net", () => ({
      MISSING_KEY_MESSAGE: "No pairing key.",
      connectServer: (onMessage: (m: unknown) => void, onState: (open: boolean) => void) => {
        onState(true);
        onMessage({ type: "osint", data });
        return { send: () => {}, close: () => {} };
      },
    }));
    const created: { textObject: { containerName: string; content: string }[] }[] = [];
    let handler: ((e: EvenHubEvent) => void) | null = null;
    const bridge = {
      createStartUpPageContainer: async (spec: (typeof created)[number]) => (created.push(spec), StartUpPageCreateResult.success),
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      onEvenHubEvent: (h: (e: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import("../src/sky/main");
    await vi.waitFor(() => expect(created).toHaveLength(1));
    handler!({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent);
    return created[0]!.textObject.find((t) => t.containerName === "list")!.content;
  }

  it("holds the list rows back while it opens, but shows them at once when an aircraft is in an emergency", async () => {
    const quiet = await firstList(false);
    expect(quiet.split("\n").filter(Boolean).length).toBeLessThan(3);
    const urgent = await firstList(true);
    expect(urgent.split("\n").filter(Boolean)).toHaveLength(3);
  });
});
