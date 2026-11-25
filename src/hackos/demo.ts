import type { HackView } from "../core/protocol";
import { hackScreen, type HackScreen } from "./view";

/**
 * Demo scenes for the glasses page: `?demo=<scene>`, no server, no pairing key,
 * no microphone. Every screen state of the app is reachable here.
 */

const PROMPT = "Give me three names for a sailing club";
const NAMES = "• Windward Club\n• The Slack Tide Society\n• Harbour Reach Sailing";
const LONG = [
  "A sailing club needs a name that sounds like water and welcome. Here are ten, with the reason for each.",
  "• Windward Club: it points into the wind, where good sailors want to be.",
  "• The Slack Tide Society: the calm between two tides, a name for people who are in no hurry.",
  "• Harbour Reach Sailing: plain and local, easy to say on the phone.",
  "• Mainsheet & Co: a nod to the rope that every sailor knows.",
  "• The Lee Shore: a little risky, so it makes members smile.",
  "• Gybe Street Yacht Club: a pun, for people who like puns.",
  "• Fair Wind Collective: warm, open, and new members feel at home.",
  "• Tack & Tell: a place to share stories after a race.",
  "• The Steady Breeze: calm and sure, good for a family club.",
  "• North Quay Sailing: names the place first, which helps people find you.",
].join("\n");

/** The board's speed bars: the heights of its 22 bars, as tokens-per-second samples whose mean is the board's 38. */
const BOARD_BARS = Array.from({ length: 22 }, (_, i) => 2 + Math.round(9 * Math.abs(Math.sin(i * 0.7 + 1) * Math.cos(i * 0.31))));
const BOARD_RATE = BOARD_BARS.map((h) => ((h - 2) * 38) / (BOARD_BARS.reduce((sum, b) => sum + (b - 2), 0) / BOARD_BARS.length));

const base: HackView = { state: "idle", model: "qwen3.8-27b", prompt: "", answer: "", stats: "", error: "", startedAt: null, history: [] };

/** A function, so `waking` and `thinking` count from the moment the page opens. */
const SCENES: Record<string, (now: number, t: number) => HackView> = {
  idle: () => base,
  recording: () => ({ ...base, state: "recording" }),
  transcribing: () => ({ ...base, state: "transcribing" }),
  // The board counts 4 + floor(t) % 50 seconds; the page turns that start time into the digits and the squares.
  waking: (now, t) => ({ ...base, state: "waking", prompt: PROMPT, startedAt: now - (4 + (Math.floor(t) % 50)) * 1000 }),
  thinking: (now) => ({ ...base, state: "thinking", prompt: PROMPT, startedAt: now - 4_000 }),
  answering: () => ({ ...base, state: "answering", prompt: PROMPT, answer: "• Windward Club\n• The Slack Tide Society", rate: BOARD_RATE }),
  done: () => ({ ...base, state: "done", prompt: PROMPT, answer: NAMES, stats: "2.1 s  ·  96 tokens", rate: BOARD_RATE }),
  long: () => ({ ...base, state: "done", prompt: PROMPT, answer: LONG, stats: "6.4s  ·  412 tokens" }),
  error: () => ({ ...base, state: "error", prompt: PROMPT, error: "The model did not answer in time. Check that the GPU is running, then try again." }),
  setup: () => ({ ...base, state: "off", error: "HackOS is not set up. Add HACKOS_URL and HACKOS_API_KEY to .env on the Mac, then restart the server." }),
};

/** The view for a demo scene, or null when the name is not one. */
export function demoView(scene: string, now = Date.now(), t = 0): HackView | null {
  return SCENES[scene]?.(now, t) ?? null;
}

export const DEMO_SCENES = Object.keys(SCENES);

/**
 * The screen of a demo scene at time `t`. The demo only supplies input (the view); the page's own code makes
 * every text, the counter and the bars from it. `t` picks the board's wake time (`4 + floor(t) % 50` seconds ago).
 */
export function demoScreen(scene: string, t: number, now = new Date(), page = 0): HackScreen | null {
  const view = demoView(scene, now.getTime(), t);
  return view ? hackScreen(view, page, now) : null;
}
