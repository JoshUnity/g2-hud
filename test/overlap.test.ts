import { OsEventTypeList, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LENS_TILES } from "../src/core/board";
import { LINE, textWidth } from "../src/core/text";
import { DEMO_SCENES as CODE_SCENES } from "../src/code/demo";

/**
 * No raster pixel may be lit under a glasses-text line. The glasses draw text over the picture, and a lit pixel
 * under a letter makes it unreadable. Each demo scene is booted headless, as pagelimits.test.ts does: the page
 * the app builds gives the text containers, and the image tiles it sends make the 576 x 288 raster. A line's
 * box is the container's x, y + 27 x line index, the line's width in pixels (src/core/text.ts) and 27 high.
 * There are no exceptions: a failing case is a real overlap for the app's owner.
 */

type TextBox = { containerName: string; xPosition: number; yPosition: number; content: string };

const WIDTH = 576;
const HEIGHT = 288;

const SCENES: Record<string, string[]> = {
  answers: ["idle", "speaking", "thinking", "paused", "answer", "sources", "long", "saved", "error", "recall", "cue"],
  code: [...CODE_SCENES],
  around: ["1", "quiet", "nolink", "stale", "nofix"],
  sky: ["1", "empty", "nolink", "stale", "loops", "nodata", "nopos", "nokey"],
};

describe("raster pixels never lie under a text line", () => {
  afterEach(() => {
    vi.doUnmock("@evenrealities/even_hub_sdk");
    vi.doUnmock("../src/core/net");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** Boots an app on a demo scene; returns the lens raster and the text lines once the page has settled. */
  async function settled(app: string, scene: string) {
    vi.resetModules();
    vi.stubGlobal("location", { search: `?demo=${scene}&intro=0&load=off`, protocol: "http:", host: "localhost" });
    const element = { style: {}, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {}, append: () => {}, remove: () => {}, textContent: "" };
    vi.stubGlobal("document", { getElementById: () => null, addEventListener: () => {}, createElement: () => element, body: { prepend: () => {} }, activeElement: null });
    vi.stubGlobal("window", { addEventListener: () => {} });
    vi.doMock("../src/core/net", () => ({
      connectServer: () => ({ send: () => {}, sendBinary: () => {}, isOpen: () => false, close: () => {} }),
      MISSING_KEY_MESSAGE: "No pairing key.",
    }));
    const texts = new Map<string, TextBox>();
    const tiles = new Map<number, Uint8Array>();
    let handler: ((event: EvenHubEvent) => void) | null = null;
    const bridge = {
      createStartUpPageContainer: async (spec: { textObject?: TextBox[] }) => {
        for (const t of spec.textObject ?? []) texts.set(t.containerName, { ...t });
        return StartUpPageCreateResult.success;
      },
      rebuildPageContainer: async () => true,
      textContainerUpgrade: async (u: { containerName: string; content: string }) => {
        const t = texts.get(u.containerName);
        if (t) t.content = u.content;
        return true;
      },
      updateImageRawData: async (u: { containerID: number; imageData: Uint8Array }) => (tiles.set(u.containerID, Uint8Array.from(u.imageData)), 0),
      audioControl: async () => true,
      onEvenHubEvent: (h: (event: EvenHubEvent) => void) => ((handler = h), () => {}),
    };
    vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
      waitForEvenAppBridge: async () => bridge,
    }));
    await import(`../src/${app}/main.ts`);
    await vi.waitFor(() => expect(tiles.size).toBe(4), { timeout: 3000 });
    // Late text (a recall cue arrives a second after the page opens).
    await new Promise((resolve) => setTimeout(resolve, scene === "recall" || scene === "cue" ? 1400 : 200));
    handler!({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent);
    const raster = new Uint8Array(WIDTH * HEIGHT);
    for (const tile of LENS_TILES) {
      const data = tiles.get(tile.id)!;
      for (let y = 0; y < tile.height; y++) raster.set(data.subarray(y * tile.width, (y + 1) * tile.width), (tile.y + y) * WIDTH + tile.x);
    }
    return { raster, texts: [...texts.values()] };
  }

  const lit = (raster: Uint8Array, x0: number, y0: number, x1: number, y1: number): number => {
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y1); y++) for (let x = Math.max(0, x0); x < Math.min(WIDTH, x1); x++) if ((raster[y * WIDTH + x] ?? 0) > 0) n++;
    return n;
  };

  for (const [app, scenes] of Object.entries(SCENES)) {
    for (const scene of scenes) {
      it(`${app} / ${scene}`, async () => {
        const { raster, texts } = await settled(app, scene);
        // The harness is real: the raster has a picture in it.
        expect(lit(raster, 0, 0, WIDTH, HEIGHT)).toBeGreaterThan(100);
        const overlaps: string[] = [];
        for (const t of texts) {
          t.content.split("\n").forEach((line, i) => {
            if (line.trim() === "") return;
            const x = t.xPosition;
            const y = t.yPosition + LINE * i;
            const w = textWidth(line);
            const n = lit(raster, x, y, x + w, y + LINE);
            if (n > 0) overlaps.push(`${t.containerName} line ${i} "${line.slice(0, 24)}" box x ${x} y ${y} w ${w} h ${LINE}: ${n} lit pixels`);
          });
        }
        expect(overlaps).toEqual([]);
      });
    }
  }
});
