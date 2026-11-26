import { ImageRawDataUpdateResult, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lensCanvas } from "../src/core/board";
import { calibrate } from "../src/core/calibrate";
import type { ServerMessage } from "../src/core/protocol";
import { clockText } from "../src/core/text";
import { drawLens } from "../src/answers/lens";
import { buildVault } from "../src/answers/vault";
import { idleEnv, initialState, screen, type HudState } from "../src/answers/view";

/**
 * The live path: real protocol messages (`vault_graph` with `total`, `answer_start` with `notes`, answer text,
 * `recall` with `card`) go through the real page with no demo scene. The texts on the glasses and the four lens
 * tiles that are sent come out of them: the tiles equal the frame the renderer makes for the same input.
 */
afterEach(() => {
  vi.doUnmock("@evenrealities/even_hub_sdk");
  vi.doUnmock("../src/core/net");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const VAULT_MESSAGE = {
  type: "vault_graph" as const,
  nodes: [
    { id: 11, title: "Sarah Chen", kind: "person" as const },
    { id: 12, title: "Pricing plan", kind: "topic" as const },
    { id: 13, title: "Northwind", kind: "topic" as const },
    { id: 14, title: "Atlas migration", kind: "topic" as const },
    { id: 15, title: "Depot stock", kind: "topic" as const },
  ],
  links: [[11, 12], [11, 13], [11, 14], [14, 15], [12, 15]] as [number, number][],
  total: { notes: 87, people: 6 },
};

async function bootLive() {
  vi.resetModules();
  vi.stubGlobal("location", { search: "?k=key&intro=0&load=off", protocol: "http:", host: "localhost" });
  vi.stubGlobal("document", { getElementById: () => null, createElement: () => ({ textContent: "", className: "" }), body: { prepend: () => {} } });
  // The pipe's clock is ours: each tile is drawn at the t we choose.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let onMessage: ((m: ServerMessage) => void) | null = null;
  let app: string | undefined;
  vi.doMock("../src/core/net", () => ({
    connectServer: (m: (m: ServerMessage) => void, c: (open: boolean) => void, name?: string) => {
      onMessage = m;
      app = name;
      queueMicrotask(() => c(true));
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
      return ImageRawDataUpdateResult.success;
    },
    audioControl: async () => true,
    onEvenHubEvent: (_h: (e: EvenHubEvent) => void) => () => {},
  };
  vi.doMock("@evenrealities/even_hub_sdk", async (importOriginal) => {
    const real = await importOriginal<typeof import("@evenrealities/even_hub_sdk")>();
    return { ...real, waitForEvenAppBridge: async () => bridge };
  });
  await import("../src/answers/main");
  await vi.waitFor(() => expect(onMessage).not.toBeNull());
  await vi.waitFor(() => expect(tiles.size).toBe(4));
  return { texts, tiles, send: (m: ServerMessage) => onMessage!(m), setNow: (ms: number) => (now = ms), app: () => app };
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

/** How many pixels differ (both are 0-255 rasters). */
const differing = (a: Uint8Array, b: Uint8Array): number => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);

/** The frame the renderer makes for a state, at lens time `t`. */
function expectedFrame(state: HudState, t: number): { pixels: Uint8Array; texts: ReturnType<typeof screen> } {
  const now = new Date();
  const s = screen(state, now, { ...idleEnv(now), t, clock: clockText(now) });
  const canvas = lensCanvas();
  drawLens(canvas, s.lens, t);
  return { pixels: calibrate(canvas.pixels), texts: s };
}

describe("Answers, live path", () => {
  it("opens the socket as Answers, then shows an answer with its sources from protocol messages", async () => {
    const { texts, tiles, send, app, setNow } = await bootLive();
    expect(app()).toBe("answers");
    send({ type: "status", text: "Listening…" });
    send(VAULT_MESSAGE);
    send({ type: "thinking", id: 1 });
    send({ type: "answer_start", id: 1, question: "What is going on with Atlas?", notes: ["Sarah Chen", "Atlas migration", "Depot stock"] });
    const answer = "- The migration moves depot stock lookups to the new service.\n- Sarah owns the pricing side.";
    send({ type: "answer_delta", id: 1, text: answer });
    send({ type: "answer_done", id: 1 });
    await vi.waitFor(() => expect(texts.get("status")).toBe("Answer"));
    await vi.waitFor(() => expect(texts.get("body")).toContain("Sarah owns"));
    expect(texts.get("question")).toBe("“What is going on with Atlas?”");

    // The lens clock reads 3 s from now on (the pipe sends a tile again only when its clock has moved).
    setNow(3000);
    // The input the page was given, built the plain way: the same frame comes out.
    const state: HudState = {
      ...initialState(),
      mode: "answer",
      question: "What is going on with Atlas?",
      answer,
      notes: ["Sarah Chen", "Atlas migration", "Depot stock"],
      answeredAt: Date.now(),
      vault: buildVault(VAULT_MESSAGE),
    };
    const want = expectedFrame(state, 3);
    expect(want.texts.lens.sources).toMatchObject({ lit: [0, 3, 4], count: 3, titles: ["Sarah Chen", "Atlas migration", "Depot stock"] });
    expect(texts.get("body")).toBe(want.texts.body.content);
    await vi.waitFor(() => expect(differing(lens(tiles), want.pixels)).toBe(0));
  });

  it("shows the recall view from a vault_graph and a recall message with a card, and its tiles equal the renderer's", async () => {
    const { texts, tiles, send, setNow } = await bootLive();
    send({ type: "status", text: "Listening…" });
    send(VAULT_MESSAGE);
    const card = { lead: "Head of procurement, Northwind", met: 4, seen: "12 Nov", last: "12 Nov  ·  Pricing plan", open: "Send the deck" };
    const facts = ["12 Nov  ·  Pricing plan", "Open: Send the deck", "Head of procurement"];
    const before = Date.now();
    send({ type: "recall", name: "Sarah Chen", facts, id: 11, card });
    await vi.waitFor(() => expect(texts.get("card1")).toBe("Head of procurement"));
    expect(["status", "card2", "card3", "card4"].map((n) => texts.get(n))).toEqual(["Recall", "Northwind  ·  met 4 times", "12 Nov  ·  Pricing plan", "Send the deck"]);
    // The recall view is on the lens (its line "VAULT 87 NOTES · 6 PEOPLE" is drawn at y 276) at lens time 0.
    await vi.waitFor(() => expect(lens(tiles).slice(276 * 576, 284 * 576).some((v) => v > 0)).toBe(true));
    // Then the entrance is over, and the lens clock reads 5 s.
    setNow(5000);
    const state: HudState = {
      ...initialState(),
      mode: "listening",
      vault: buildVault(VAULT_MESSAGE),
      cue: { name: "Sarah Chen", facts, id: 11, card, arrivedAt: before, shownAt: before, onLensAt: before, seen: false },
    };
    const want = expectedFrame(state, 5);
    expect(want.texts.recall).toMatchObject({ focus: 0, linked: [1, 2, 3], seen: "12 Nov", hasLast: true, hasOpen: true });
    await vi.waitFor(() => expect(differing(lens(tiles), want.pixels)).toBe(0), { timeout: 4000 });
  });
});
