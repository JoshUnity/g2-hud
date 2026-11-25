import { StartUpPageCreateResult, type EvenHubEvent, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LENS_TILES } from "../src/core/board";
import { LIGHT } from "../src/core/hud";

/** One page as the app hands it to the host. Only the fields the platform limits are about. */
type Box = { containerID: number; containerName: string; zOrderIndex?: number };
type Spec = {
  imageObject?: (Box & { width: number; height: number })[];
  textObject?: (Box & { isEventCapture?: number; textColor?: number }) [];
};

/**
 * The Even Hub limits for one page (see DESIGN.md, "Layout"): at most 4 image containers of 20 x 20 to
 * 288 x 144, at most 8 text containers, unique ids and names of at most 16 characters, exactly one container
 * that takes input, and `zOrderIndex` on every container or on none, never repeated.
 */
function expectWithinLimits(spec: Spec): void {
  const images = spec.imageObject ?? [];
  const texts = spec.textObject ?? [];
  expect(images.length).toBeLessThanOrEqual(4);
  expect(texts.length).toBeLessThanOrEqual(8);
  for (const image of images) {
    expect(image.width, image.containerName).toBeGreaterThanOrEqual(20);
    expect(image.width, image.containerName).toBeLessThanOrEqual(288);
    expect(image.height, image.containerName).toBeGreaterThanOrEqual(20);
    expect(image.height, image.containerName).toBeLessThanOrEqual(144);
  }
  const all: Box[] = [...images, ...texts];
  expect(new Set(all.map((b) => b.containerID)).size).toBe(all.length);
  expect(new Set(all.map((b) => b.containerName)).size).toBe(all.length);
  for (const b of all) expect(b.containerName.length, b.containerName).toBeLessThanOrEqual(16);
  expect(texts.filter((t) => t.isEventCapture === 1)).toHaveLength(1);
  const z = all.map((b) => b.zOrderIndex);
  if (z.some((v) => v !== undefined)) {
    expect(z.every((v) => typeof v === "number")).toBe(true);
    expect(new Set(z).size).toBe(all.length);
  }
}

describe("every app's page stays within the platform limits", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Boots an app's page against a fake host, and returns the first page it created. */
  async function firstPage(app: string, search: string): Promise<Spec> {
    vi.resetModules();
    vi.stubGlobal("location", { search, protocol: "http:", host: "localhost" });
    const element = { style: {}, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {}, append: () => {}, textContent: "" };
    vi.stubGlobal("document", { getElementById: () => null, addEventListener: () => {}, createElement: () => element, body: { prepend: () => {} } });
    vi.stubGlobal("window", { addEventListener: () => {} });
    vi.doMock("../src/core/net", () => ({
      connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => false, close: () => {} }),
      MISSING_KEY_MESSAGE: "No pairing key.",
    }));
    const created: Spec[] = [];
    let handler: ((event: EvenHubEvent) => void) | null = null;
    const bridge = {
      createStartUpPageContainer: async (spec: Spec) => (created.push(spec), StartUpPageCreateResult.success),
      rebuildPageContainer: async () => true,
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 0,
      audioControl: async () => true,
      onEvenHubEvent: (h: (event: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import(`../src/${app}/main.ts`);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    // Stops the page's timers and image loops, so nothing outlives the test.
    handler!({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent);
    return created[0]!;
  }

  const base = "&intro=0&load=off";
  /** [label, app, URL query, a text container only that app has: proves the right page was built]. */
  const pages: [string, string, string, string][] = [
    ["answers", "answers", `?demo=idle${base}`, "card1"],
    ["around", "around", `?demo=1${base}`, "row1"],
    ["code (working)", "code", `?demo=working${base}`, "steps"],
    ["code (approval state, same page)", "code", `?demo=approval${base}`, "call"],
    ["hackos", "hackos", `?demo=idle${base}`, "sentence"],
    ["sky", "sky", `?demo=1${base}`, "list"],
  ];
  for (const [label, app, search, marker] of pages) {
    it(`${label} opens a page within the limits`, async () => {
      const spec = await firstPage(app, search);
      expect((spec.textObject ?? []).map((b) => b.containerName)).toContain(marker);
      expectWithinLimits(spec);
    });
    it(`${label} draws the lens as the four tiles, behind the text`, async () => {
      const spec = await firstPage(app, search);
      expect((spec.imageObject ?? []).map((b) => b.containerName)).toEqual(LENS_TILES.map((b) => b.name));
      const z = (b: { zOrderIndex?: number }) => b.zOrderIndex ?? -1;
      expect(Math.max(...(spec.imageObject ?? []).map(z))).toBeLessThan(Math.min(...(spec.textObject ?? []).map(z)));
    });
    it(`${label} shows its status at the one brightness`, async () => {
      const spec = await firstPage(app, search);
      expect(spec.textObject?.find((t) => t.containerName === "status")?.textColor).toBe(LIGHT.near);
    });
  }
});
