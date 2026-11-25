import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { ImagePipe } from "../core/imagepipe";
import { Sigil } from "./animator";
import { SIGIL, initialState, screen, type HudState } from "./hud";
import { createPage } from "./pages";

/**
 * Fixed scenes without the server or microphone, for design work:
 * open http://localhost:5173/apps/answers/?demo=answer in the simulator.
 * Scenes: idle, speaking, thinking, answer, long, paused, saved, error, recall.
 */
const now = Date.now();
const scenes: Record<string, Partial<HudState>> = {
  idle: { mode: "listening" },
  speaking: { mode: "listening" },
  thinking: { mode: "thinking", question: "What would it cost to run this for the whole team?" },
  paused: { mode: "paused" },
  answer: {
    mode: "answer",
    answeredAt: now,
    question: "So what are you working on these days?",
    answer: "- Mostly the route planner app at Acme Freight.\n- This week: faster stock lookups from depot records.\n- Happy to show you a demo later.",
  },
  long: {
    mode: "answer",
    answeredAt: now,
    question: "Can you walk me through what happens when a depot closes in the middle of a delivery shift?",
    answer: "- Open stops move to the nearest depot that still has the parts in stock.\n- Drivers get the new route on their phone in a minute.\n- Stops it cannot reach today move to tomorrow.\n- Dispatch sees every change on the live map.\n- Customers get a text with their new delivery window before noon.\n- I can show you a replay of last week's closure.",
    follow: false,
    page: 0,
  },
  saved: { mode: "listening", toast: { text: "SAVED  ·  Pricing call with Sarah", until: now + 60_000 } },
  error: { mode: "error", error: "Speech-to-text is not running. Start everything with npm run dev." },
  recall: {
    mode: "listening",
    cue: {
      name: "Sarah Chen",
      facts: ["12 Nov  ·  Pricing plan with Sarah", "Open: Send the deck", "Head of procurement, Northwind."],
      arrivedAt: now,
      shownAt: now,
      seen: false,
    },
  },
};


export async function runDemo(name: string): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const pipe = new ImagePipe(bridge);
  const state = { ...initialState(), ...(scenes[name] ?? scenes.idle) };
  const view = screen(state, new Date());
  await createPage(bridge, { status: view.status, clock: view.clock, question: view.question, card: view.card });
  const sigil = new Sigil(SIGIL);
  sigil.setMode(view.sigil);
  pipe.set([sigil.producer()]);
  void pipe.run();
  if (name === "speaking") setInterval(() => sigil.setLevel(0.4 + 0.5 * Math.abs(Math.sin(Date.now() / 300))), 100);
}
