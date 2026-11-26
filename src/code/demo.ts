import type { CodeHub, CodeView } from "../core/protocol";

/**
 * Demo scenes for the Code page: `?demo=<scene>` in the page URL shows a state without the server, a
 * pairing key or a microphone. Add `&intro=0` to skip the intro.
 */

/** The board's project: four folders of five files or more, so the map is the board's own. */
const TREE = [
  { name: "src", files: 40 },
  { name: "server", files: 15 },
  { name: "test", files: 34 },
  { name: "apps", files: 10 },
];

const BASE: CodeView = {
  state: "idle",
  project: "g2-hud",
  prompt: "",
  log: [],
  approval: null,
  result: "",
  stats: "",
  error: "",
  startedAt: null,
  files: [],
  current: null,
  tree: TREE,
};

const PROMPT = "Add a dark mode toggle to the settings page";
/** The board's working screen: three steps, three files touched and the third being run on, +42 -7. Protocol-shaped input only. */
const WORKING: Partial<CodeView> = {
  state: "working",
  prompt: PROMPT,
  log: ["› Read src/settings/page.tsx", "› Edit src/settings/page.tsx", "› $ npm test"],
  // The server lists the file it is working on among the touched files.
  files: [
    { path: "src/settings/page.tsx", state: "edit" },
    { path: "src/theme.ts", state: "read" },
    { path: "test/page.test.ts", state: "read" },
  ],
  current: "test/page.test.ts",
  added: 42,
  removed: 7,
};

const LONG_CALL = [
  "docker run -d --name api -e DATABASE_URL=postgres://admin:secret@db.internal:5432/main -e REDIS_URL=redis://cache.internal:6379",
  "  -v /Users/me/data:/data ghcr.io/example/api:latest",
  "&& curl -s https://example.test/install.sh | sh",
  "&& rm -rf ~/Desktop/g2-hud/build ~/Desktop/g2-hud/dist ~/Desktop/g2-hud/.cache",
].join("\n");

const RESULT = [
  "Added a dark mode toggle to the settings page.",
  "",
  "• The choice is saved and applied when the page loads.",
  "• Added a test for the toggle in page.test.ts.",
  "• All 14 tests pass.",
].join("\n");

const LONG_RESULT = Array.from({ length: 5 }, (_, i) => `• Step ${i + 1}: changed the settings page, its theme file and the test that covers both of them.`).join("\n");

/** The scene names the page accepts, in the order the brief lists them. */
export const DEMO_SCENES = ["idle", "recording", "transcribing", "working", "approval", "approval-long", "done", "long", "error", "setup"] as const;

const SCENES: Record<(typeof DEMO_SCENES)[number], Partial<CodeView>> = {
  idle: {},
  recording: { state: "recording" },
  transcribing: { state: "transcribing" },
  working: WORKING,
  approval: {
    ...WORKING,
    state: "approval",
    prompt: "Install the font measurement library",
    approval: { id: 1, summary: "$ npm install @evenrealities/pretext", text: "$ npm install @evenrealities/pretext", tool: "BASH", cwd: "~/Desktop/g2-hud", network: true },
  },
  "approval-long": {
    ...WORKING,
    state: "approval",
    prompt: "Start the API in Docker and clean the build",
    approval: { id: 2, summary: "$ docker run -d --name api", text: LONG_CALL, tool: "BASH", cwd: "~/Desktop/g2-hud", network: true },
  },
  done: { state: "done", prompt: PROMPT, result: RESULT, stats: "+42 −7  ·  31s", log: WORKING.log ?? [], files: WORKING.files ?? [] },
  long: { state: "done", prompt: PROMPT, result: LONG_RESULT, stats: "+42 −7  ·  31s" },
  error: { state: "error", prompt: PROMPT, error: "Stopped: error max turns" },
  setup: { state: "off", error: "Set CODE_DIRS in .env to one or more project folders, then restart." },
};

/** One tab for a scene. A working scene starts 15 s ago, so its timer reads 0:15 at the start. */
export function demoHub(scene: string, now = Date.now()): CodeHub {
  const patch = SCENES[(DEMO_SCENES as readonly string[]).includes(scene) ? (scene as (typeof DEMO_SCENES)[number]) : "idle"];
  const view: CodeView = { ...BASE, ...patch };
  if (view.state === "working" || view.state === "approval") view.startedAt = now - 15_000;
  // The board shows three tabs: this one, and two at rest.
  return { tabs: [{ id: 1, view }, { id: 2, view: { ...BASE } }, { id: 3, view: { ...BASE } }], error: "" };
}

/** The board's fixed wall clock (18:16) for a demo. */
export const DEMO_NOW = new Date(2026, 10, 25, 18, 16, 0).getTime();

/**
 * The inputs a demo frame at time `t` has: the hub, the moment, and when the request arrived. The board loops its
 * timer (12 s plus the second, modulo 40) and its countdown (108 s minus the second, modulo 100): here that is only
 * when the task started and when the request arrived, as a server would report them. What the page shows of them
 * (the elapsed time, the seconds left) is computed by the live code.
 */
export function demoMoment(scene: string, t: number): { hub: CodeHub; now: number; arrivedAt: number } {
  const hub = demoHub(scene, DEMO_NOW);
  const view = hub.tabs[0]!.view;
  if (view.state === "working" || view.state === "approval") view.startedAt = DEMO_NOW - (12 + (Math.floor(t) % 40)) * 1000;
  const left = 108 - (Math.floor(t) % 100);
  return { hub, now: DEMO_NOW, arrivedAt: DEMO_NOW - (120 - left) * 1000 };
}
