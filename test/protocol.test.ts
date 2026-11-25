import { describe, expect, it } from "vitest";
import { ClientMessageSchema, MapSchema, ServerMessageSchema } from "../src/core/protocol";

describe("recall messages", () => {
  const recall = { type: "recall", name: "Sarah Chen", facts: ["12 Nov  ·  Pricing plan with Sarah", "Open: Send the deck", "Head of procurement, Northwind."] };

  it("parses a recall message", () => {
    expect(ServerMessageSchema.safeParse(recall)).toEqual({ success: true, data: recall });
  });

  it("rejects 4 facts, 0 facts and a 61-character name", () => {
    expect(ServerMessageSchema.safeParse({ ...recall, facts: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...recall, facts: [] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...recall, name: "x".repeat(61) }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...recall, name: "x".repeat(60) }).success).toBe(true);
  });

  it("rejects an empty name and a fact over 80 characters", () => {
    expect(ServerMessageSchema.safeParse({ ...recall, name: "" }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...recall, facts: ["x".repeat(81)] }).success).toBe(false);
  });

  it("parses recall_shown through ClientMessageSchema", () => {
    const shown = { type: "recall_shown", name: "Sarah Chen" };
    expect(ClientMessageSchema.safeParse(shown)).toEqual({ success: true, data: shown });
    expect(ClientMessageSchema.safeParse({ type: "recall_shown", name: "" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "recall_shown", name: "x".repeat(61) }).success).toBe(false);
  });
});

describe("v2 protocol fields", () => {
  const recall = { type: "recall", name: "Sarah Chen", facts: ["a"] };
  const start = { type: "answer_start", id: 1, question: "q?" };
  const view = { state: "idle", project: "p", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
  const code = (extra: object) => ServerMessageSchema.safeParse({ type: "code", data: { tabs: [{ id: 1, view: { ...view, ...extra } }], error: "" } }).success;

  it("still parses the old shapes", () => {
    expect(ServerMessageSchema.safeParse(recall).success).toBe(true);
    expect(ServerMessageSchema.safeParse(start).success).toBe(true);
    expect(code({})).toBe(true);
  });

  it("parses recall.id and rejects a negative or fractional one", () => {
    expect(ServerMessageSchema.safeParse({ ...recall, id: 0 }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...recall, id: -1 }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...recall, id: 1.5 }).success).toBe(false);
  });

  it("parses answer_start.notes within 6 items of 1-40 characters", () => {
    expect(ServerMessageSchema.safeParse({ ...start, notes: ["a", "x".repeat(40)] }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...start, notes: Array(7).fill("a") }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...start, notes: [""] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...start, notes: ["x".repeat(41)] }).success).toBe(false);
  });

  it("parses vault_graph and rejects bad nodes and limits", () => {
    const graph = { type: "vault_graph", nodes: [{ id: 0, title: "Sarah Chen", kind: "person" }, { id: 1, title: "Pricing plan", kind: "meeting" }], links: [[0, 1]] };
    expect(ServerMessageSchema.safeParse(graph).success).toBe(true);
    const node = { id: 0, title: "a", kind: "topic" };
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: [{ ...node, kind: "file" }] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: [{ ...node, id: -1 }] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: [{ ...node, title: "" }] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: [{ ...node, title: "x".repeat(41) }] }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: Array(80).fill(node) }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...graph, nodes: Array(81).fill(node) }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, links: Array(240).fill([0, 1]) }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...graph, links: Array(241).fill([0, 1]) }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, links: [[0, 1.5]] }).success).toBe(false);
  });

  it("parses the Code files, current and tree fields", () => {
    expect(code({ files: [{ path: "src/a.ts", state: "read" }, { path: "b.ts", state: "edit" }], current: "b.ts", tree: [{ name: "src", files: 12 }] })).toBe(true);
    expect(code({ current: null })).toBe(true);
    expect(code({ files: [{ path: "a", state: "run" }] })).toBe(false);
    expect(code({ files: [{ path: "", state: "read" }] })).toBe(false);
    expect(code({ files: Array(25).fill({ path: "a", state: "read" }) })).toBe(false);
    expect(code({ current: "x".repeat(121) })).toBe(false);
    expect(code({ tree: Array(13).fill({ name: "a", files: 1 }) })).toBe(false);
    expect(code({ tree: [{ name: "a", files: -1 }] })).toBe(false);
  });
});

describe("MapSchema buildings", () => {
  const base = { center: { lat: 1, lon: 2 }, roads: [], water: [], green: [] };
  const ring = (n: number) => Array.from({ length: n }, (_, i) => [1 + i * 0.0001, 2] as [number, number]);

  it("accepts a map with and without buildings", () => {
    expect(MapSchema.safeParse(base).success).toBe(true);
    expect(MapSchema.safeParse({ ...base, buildings: [{ ring: ring(4), height: 12 }] }).success).toBe(true);
  });

  it("rejects a ring of 3 points or a height of 0", () => {
    expect(MapSchema.safeParse({ ...base, buildings: [{ ring: ring(3), height: 12 }] }).success).toBe(false);
    expect(MapSchema.safeParse({ ...base, buildings: [{ ring: ring(4), height: 0 }] }).success).toBe(false);
  });
});

describe("board fields (all optional)", () => {
  const recall = { type: "recall", name: "Sarah Chen", facts: ["a"] };
  const card = { lead: "Head of procurement", met: 4, seen: "12 NOV", last: "12 Nov  ·  Pricing plan", open: "Send the deck" };
  const view = { state: "idle", project: "p", prompt: "", log: [], approval: null, result: "", stats: "", error: "", startedAt: null };
  const code = (extra: object, approval?: object) =>
    ServerMessageSchema.safeParse({ type: "code", data: { tabs: [{ id: 1, view: { ...view, ...extra, ...(approval ? { approval: { id: 1, summary: "s", text: "t", ...approval } } : {}) } }], error: "" } }).success;
  const hack = (extra: object) =>
    ServerMessageSchema.safeParse({ type: "hack", data: { state: "idle", model: "m", prompt: "", answer: "", stats: "", error: "", startedAt: null, history: [], ...extra } }).success;
  const osint = (aircraft: object) =>
    ServerMessageSchema.safeParse({
      type: "osint",
      data: { connected: true, error: null, at: 1, me: null, items: [], vehicles: [], aircraft: [{ id: "a", callsign: null, lat: 1, lon: 2, altitude_ft: 1000, track: null, speed_kt: null, emergency: false, trail: [], ...aircraft }] },
    }).success;

  it("keeps recall.card and limits its parts", () => {
    expect(ServerMessageSchema.safeParse({ ...recall, card })).toEqual({ success: true, data: { ...recall, card } });
    expect(ServerMessageSchema.safeParse({ ...recall, card: {} }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...recall, card: { lead: "x".repeat(80), seen: "x".repeat(12), last: "x".repeat(60), open: "x".repeat(60) } }).success).toBe(true);
    for (const bad of [{ lead: "x".repeat(81) }, { seen: "x".repeat(13) }, { last: "x".repeat(61) }, { open: "x".repeat(61) }, { met: -1 }, { met: 1.5 }]) {
      expect(ServerMessageSchema.safeParse({ ...recall, card: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps vault_graph.total", () => {
    const graph = { type: "vault_graph", nodes: [], links: [] };
    expect(ServerMessageSchema.safeParse({ ...graph, total: { notes: 214, people: 11 } })).toEqual({ success: true, data: { ...graph, total: { notes: 214, people: 11 } } });
    expect(ServerMessageSchema.safeParse(graph).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...graph, total: { notes: -1, people: 0 } }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, total: { notes: 1.5, people: 0 } }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...graph, total: { notes: 1 } }).success).toBe(false);
  });

  it("takes added and removed on a code view and tool, cwd and network on its approval", () => {
    expect(code({ added: 42, removed: 7 })).toBe(true);
    expect(code({ added: -1 })).toBe(false);
    expect(code({ removed: 1.5 })).toBe(false);
    expect(code({}, { tool: "Bash", cwd: "~/Desktop/g2-hud", network: true })).toBe(true);
    expect(code({}, { tool: "x".repeat(24), cwd: "x".repeat(80) })).toBe(true);
    expect(code({}, { tool: "x".repeat(25) })).toBe(false);
    expect(code({}, { cwd: "x".repeat(81) })).toBe(false);
    expect(code({}, { network: "yes" })).toBe(false);
    expect(code({}, {})).toBe(true);
  });

  it("takes a rate of up to 22 values of 0 or more on a hack view", () => {
    expect(hack({})).toBe(true);
    expect(hack({ rate: [0, 38.5, 40] })).toBe(true);
    expect(hack({ rate: Array(22).fill(1) })).toBe(true);
    expect(hack({ rate: Array(23).fill(1) })).toBe(false);
    expect(hack({ rate: [-1] })).toBe(false);
  });

  it("takes vrate on an aircraft, a number, null or none", () => {
    expect(osint({})).toBe(true);
    expect(osint({ vrate: 1800 })).toBe(true);
    expect(osint({ vrate: -600 })).toBe(true);
    expect(osint({ vrate: null })).toBe(true);
    expect(osint({ vrate: "up" })).toBe(false);
  });
});
