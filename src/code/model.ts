import type { TabState } from "../core/board";
import type { CodeView } from "../core/protocol";
import type { IconState } from "./glyph";
import { buildMap, clockMs, type LensModel } from "./lens";
import { stepCount, type CodeScreen } from "./view";

/** What the live page knows at the moment of a frame: the clock text, the voice level, the time worked and the seconds the request has left. */
export type LensInput = { clock: string; level: number; elapsedMs: number; remaining: number };

/** The seconds a request has in all: as APPROVAL_TIMEOUT_MS in server/coder.ts. */
export const APPROVAL_SECONDS = 120;

/**
 * Computes the frame's inputs from the view and the moment (`now`, ms): the wall clock, the time since the task
 * started, and the seconds left of the request that arrived at `arrivedAt`. The live page and a demo use this one path.
 */
export function liveInput(view: CodeView | null, arrivedAt: number | undefined, now: number, level: number): LensInput {
  const time = new Date(now);
  return {
    clock: `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`,
    level,
    elapsedMs: view?.startedAt ? now - view.startedAt : 0,
    remaining: arrivedAt === undefined ? APPROVAL_SECONDS : APPROVAL_SECONDS - (now - arrivedAt) / 1000,
  };
}

/** The files of the map: the touched files, and the current file even when the list does not hold it yet. */
const touchedFiles = (view: CodeView): { path: string; state: "read" | "edit" }[] => {
  const files = [...(view.files ?? [])];
  if (view.current && !files.some((f) => f.path === view.current)) files.push({ path: view.current, state: "read" });
  return files;
};

/** The raster's model for a screen: the same numbers the glasses text is built from, plus the clock and the countdown. */
export function buildLens(s: CodeScreen, view: CodeView | null, tabs: TabState[], o: LensInput): LensModel {
  const tree = view?.tree ?? [];
  const live = s.scene === "live";
  const files = view?.files?.length ?? 0;
  return {
    scene: s.scene,
    icon: s.icon satisfies IconState,
    level: o.level,
    clock: o.clock,
    tabs,
    rows: s.rows,
    elapsed: clockMs(o.elapsedMs),
    steps: stepCount(view?.log ?? []),
    files: { count: files, atLeast: files >= 24 },
    diff: view && view.added !== undefined && view.removed !== undefined ? { added: view.added, removed: view.removed } : null,
    map: buildMap(view?.project ?? "", tree, live && view ? touchedFiles(view) : [], live ? (view?.current ?? null) : null),
    tag: s.tag,
    network: s.network,
    remaining: Math.max(0, Math.min(120, Math.floor(o.remaining))),
  };
}

