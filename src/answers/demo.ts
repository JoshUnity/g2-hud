import { meterLevels } from "../core/board";
import { clockText } from "../core/text";
import { boardColumns } from "./ribbon";
import type { Vault, VaultNode } from "./vault";
import type { Env, HudCue, HudState } from "./view";

/**
 * Fixed scenes without the server or microphone, for design work:
 * open http://localhost:5173/apps/answers/?demo=answer in the simulator (add &intro=0 to skip the intro).
 * Scenes: idle, speaking, thinking, answer, long, sources, paused, saved, error, recall, cue.
 * The content is the board's (`test/board/hud.cjs`): its vault, its names, its answer and its numbers.
 */

/** The board's random generator (mulberry32), with its own state. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The board's `VG`: 40 nodes and their links, made by the board's own generator (same seed, same code). */
export function boardVault(): Vault {
  const r = rng(7);
  const points: [number, number, number][] = [[0.08, 0.04, -0.12], [0.5, 0.34, -0.3], [-0.2, 0.55, 0.15], [0.3, -0.45, -0.38]];
  const links: [number, number][] = [[0, 1], [0, 2], [0, 3]];
  const centres: [number, number, number][] = [[0.62, 0.2, 0.32], [-0.62, 0.3, -0.2], [0, -0.62, 0.46], [-0.22, 0.1, -0.72], [0.3, 0.72, -0.1]];
  for (let i = 4; i < 40; i++) {
    const c = centres[i % 5] ?? [0, 0, 0];
    points.push([c[0] + (r() - 0.5) * 0.72, c[1] + (r() - 0.5) * 0.72, c[2] + (r() - 0.5) * 0.72]);
  }
  for (let i = 4; i < points.length; i++) {
    let best = 0;
    let bd = 9;
    for (let j = 0; j < i; j++) {
      const a = points[i] ?? [0, 0, 0];
      const b = points[j] ?? [0, 0, 0];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    links.push([i, best]);
    if (r() < 0.4) links.push([i, Math.floor(r() * i)]);
  }
  const titles = ["Sarah Chen", "Pricing plan", "Northwind", "Atlas migration"];
  const nodes: VaultNode[] = points.map((_, i) => ({ id: i, title: titles[i] ?? `Note ${i}`, kind: i === 0 || i === 2 ? "person" : "topic" }));
  return { nodes, graph: { points, links }, people: nodes.filter((n) => n.kind === "person").length, total: { notes: 214, people: 11 } };
}

export const SARAH: Pick<HudCue, "name" | "facts" | "id" | "card"> = {
  name: "Sarah Chen",
  id: 0,
  facts: ["12 Nov  ·  Pricing plan with Sarah", "Open: Send the deck", "Head of procurement, Northwind."],
  card: { lead: "Head of procurement, Northwind", met: 4, seen: "12 Nov", last: "12 Nov  ·  Pricing plan", open: "Send the deck" },
};

const ANSWER = "- Mostly the route planner app at Acme Freight.\n- This week: faster stock lookups from depot records.\n- Happy to show you a demo later.";
const QUESTION = "So what are you working on these days?";

/** The time of day on the board's clock: the lens draws it with the same code as a real time. */
const BOARD_TIME = new Date(2026, 10, 25, 18, 16);

/** The board's values for the changing parts, at time `t`: its clock, its meter, its ribbon. */
export function boardEnv(t: number): Env {
  return { t, clock: clockText(BOARD_TIME), meter: meterLevels(t), columns: boardColumns(t), open: null, entrance: 1, since: 0, level: 0 };
}

/** A scene's input: raw state (question, answer, notes), and flags that ask the page to feed messages (the recall cue, the saved status) the way the server does. */
export function scene(name: string, now: number): { state: Partial<HudState>; voice: boolean; vault: boolean; cue: boolean; saved?: boolean } {
  const base = { voice: false, vault: true, cue: false };
  switch (name) {
    case "speaking":
      return { ...base, state: { mode: "listening" }, voice: true };
    case "thinking":
      return { ...base, state: { mode: "thinking", question: "What would it cost to run this for the whole team?" } };
    case "paused":
      return { ...base, state: { mode: "paused" } };
    case "answer":
      return { ...base, state: { mode: "answer", answeredAt: now, question: QUESTION, answer: ANSWER } };
    case "sources":
      // The board's answer: three notes of the board's vault, so the orb is lit at nodes 0, 1 and 3.
      return {
        ...base,
        state: { mode: "answer", answeredAt: now, question: QUESTION, answer: ANSWER, notes: ["Sarah Chen", "Pricing plan", "Atlas migration"] },
      };
    case "long":
      return {
        ...base,
        state: {
          mode: "answer",
          answeredAt: now,
          question: "Can you walk me through what happens when a depot closes in the middle of a delivery shift?",
          answer:
            "- Open stops move to the nearest depot that still has the parts in stock.\n- Drivers get the new route on their phone in a minute.\n- Stops it cannot reach today move to tomorrow.\n- Dispatch sees every change on the live map.\n- Customers get a text with their new delivery window before noon.\n- I can show you a replay of last week's closure.",
          follow: false,
          page: 0,
        },
      };
    case "saved":
      return { ...base, state: { mode: "listening" }, saved: true };
    case "error":
      return { ...base, state: { mode: "error", error: "Speech-to-text is not running. Start everything with npm run dev." } };
    case "recall":
      return { ...base, state: { mode: "listening" }, cue: true };
    case "cue":
      // No graph: the cue has no node, so it shows as two lines in the question place.
      return { vault: false, voice: false, cue: true, state: { mode: "listening" } };
    default:
      return { ...base, state: { mode: "listening" } };
  }
}

/** A made-up voice, for the "speaking" scene: 4 s of speech with syllables, then a pause. */
export function fakeLevel(ms: number): number {
  if (ms % 6000 > 4200) return 0;
  return 0.35 + 0.65 * Math.abs(Math.sin(ms / 130)) * (0.6 + 0.4 * Math.sin(ms / 700));
}
