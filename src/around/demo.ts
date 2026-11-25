import type { LocalMap, Osint } from "../core/protocol";
import type { Link } from "./render";
import { SAMPLE_MAP, SAMPLE_OSINT } from "./sample";

/** A screen of Around that needs no server: `?demo=<scene>`. */
export type Scene = {
  osint: Osint | null;
  map: LocalMap | null;
  link: Link;
  /** The clock stands still at the sample's own time, so the sample never goes stale. */
  frozen: boolean;
  /** The header clock: input, as the board's frozen "18:16". */
  clock: string;
};

const live: Scene = { osint: SAMPLE_OSINT, map: SAMPLE_MAP, link: "open", frozen: true, clock: "18:16" };

/** The scene for a `demo` value. Unknown values (and `1`) show the live scene. */
export function demoScene(name: string): Scene {
  switch (name) {
    case "quiet":
      return { ...live, osint: { ...SAMPLE_OSINT, items: [] } };
    case "nolink":
      return { ...live, link: "closed" };
    case "stale":
      return { ...live, osint: { ...SAMPLE_OSINT, at: SAMPLE_OSINT.at - 180 }, frozen: false };
    case "nofix":
      return { ...live, osint: { ...SAMPLE_OSINT, me: null }, map: null };
    default:
      return live;
  }
}
