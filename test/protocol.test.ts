import { describe, expect, it } from "vitest";
import { ClientMessageSchema, ServerMessageSchema } from "../src/core/protocol";

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
