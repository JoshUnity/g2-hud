import { StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calibrate } from "../src/core/calibrate";
import { incidentRows, renderAround, summaryText } from "../src/around/render";
import { SAMPLE_MAP, SAMPLE_OSINT } from "../src/around/sample";
import type { Osint, ServerMessage } from "../src/core/protocol";
import { clockText } from "../src/core/text";

/**
 * The live path: real `osint` and `osint_map` protocol messages go through the page (no demo scene), and the
 * rows, the header counts and the picture on the glasses come out of them.
 */
afterEach(() => {
  vi.doUnmock("@evenrealities/even_hub_sdk");
  vi.doUnmock("../src/core/net");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The third argument of every connectServer call: the server picks its feed from it. */
const appNames: (string | undefined)[] = [];

type Tile = { id: number; pixels: Uint8Array };

async function bootLive(osint: Osint) {
  appNames.length = 0;
  vi.resetModules();
  vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
  vi.stubGlobal("document", { getElementById: () => null, createElement: () => ({}), body: { prepend: () => {} } });
  // The pipe's clock stands still, so each of the four tiles is drawn once, at t = 0.
  vi.spyOn(performance, "now").mockReturnValue(0);
  let onMessage: ((m: ServerMessage) => void) | null = null;
  let onConnection: ((open: boolean) => void) | null = null;
  vi.doMock("../src/core/net", () => ({
    connectServer: (m: (m: ServerMessage) => void, c: (open: boolean) => void, name?: string) => {
      appNames.push(name);
      onMessage = m;
      onConnection = c;
      return { send: () => {}, sendBinary: () => {}, isOpen: () => true, close: () => {} };
    },
  }));
  const texts = new Map<string, string>();
  const tiles = new Map<number, Uint8Array>();
  const bridge = {
    createStartUpPageContainer: async (spec: { textObject?: { containerName: string; content: string }[] }) => {
      for (const t of spec.textObject ?? []) texts.set(t.containerName, t.content);
      return StartUpPageCreateResult.success;
    },
    textContainerUpgrade: async (u: { containerName: string; content: string }) => {
      texts.set(u.containerName, u.content);
      return true;
    },
    updateImageRawData: async (u: { containerID: number; imageData: number[] | Uint8Array }) => {
      tiles.set(u.containerID, Uint8Array.from(u.imageData as ArrayLike<number>));
      return 0;
    },
    onEvenHubEvent: (_h: (e: EvenHubEvent) => void) => () => {},
  };
  vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => {
    const real = await importOriginal<typeof import("@evenrealities/even_hub_sdk")>();
    // The page spec is read as the plain objects the host gets.
    return { ...real, waitForEvenAppBridge: async () => bridge };
  });
  await import("../src/around/main");
  await vi.waitFor(() => expect(onMessage).not.toBeNull());
  onConnection!(true);
  onMessage!({ type: "osint_map", data: SAMPLE_MAP } as ServerMessage);
  onMessage!({ type: "osint", data: osint } as ServerMessage);
  return { texts, tiles };
}

/** The four tiles put back into one 576 x 288 picture. */
function lens(tiles: Map<number, Uint8Array>): Uint8Array {
  const out = new Uint8Array(576 * 288);
  const at: Record<number, [number, number]> = { 1: [0, 0], 2: [288, 0], 3: [0, 144], 4: [288, 144] };
  for (const [id, [x0, y0]] of Object.entries(at).map(([k, v]) => [Number(k), v] as const)) {
    const tile = tiles.get(id) ?? new Uint8Array(288 * 144);
    for (let y = 0; y < 144; y++) out.set(tile.subarray(y * 288, y * 288 + 288), (y0 + y) * 576 + x0);
  }
  return out;
}

describe("Around, live path", () => {
  it("connects to the server as the around app", async () => {
    await bootLive({ ...SAMPLE_OSINT, at: Date.now() / 1000 });
    expect(appNames).toEqual(["around"]);
  });

  it("builds the rows, the counts and the picture from protocol messages", async () => {
    const osint: Osint = { ...SAMPLE_OSINT, at: Date.now() / 1000 };
    const { texts, tiles } = await bootLive(osint);
    await vi.waitFor(() => expect(tiles.size).toBe(4));
    await vi.waitFor(() => expect(texts.get("row1")).toBe("Collision, two lanes closed"));
    // Rows: computed from the incidents' places, most severe first.
    expect(incidentRows(osint).map((r) => [r.title, r.dist, r.deg])).toEqual([
      ["Collision, two lanes closed", "440M", 18],
      ["Road closed for works", "310M", 306],
    ]);
    expect(texts.get("status")).toBe("Harbour Quarter");
    expect(texts.get("row2")).toBe("Road closed for works");
    // The picture: the same frame the renderer makes from that feed, with the header counts and the clock in it.
    const expected = renderAround(SAMPLE_MAP, osint, 0, 0, true, 1, { clock: clockText(new Date()) });
    expect(lens(tiles)).toEqual(calibrate(expected));
    expect(summaryText(osint)).toBe("3 ALERTS  ·  4 AIRCRAFT");
  });

  it("shows no moving layers and no rows when Loops stops answering", async () => {
    const { texts, tiles } = await bootLive({ ...SAMPLE_OSINT, at: Date.now() / 1000, connected: false, error: "no route", items: [], aircraft: [] });
    await vi.waitFor(() => expect(tiles.size).toBe(4));
    await vi.waitFor(() => expect(texts.get("row1")).toBe("The data feed is not reachable."));
    expect(texts.get("status")).toBe("Around");
  });
});
