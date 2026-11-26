import { SAMPLE_OSINT } from "../around/sample";
import type { Link } from "../around/render";
import { MISSING_KEY_MESSAGE } from "../core/net";
import type { Osint } from "../core/protocol";
import { skyPlanes, type SkyPlane } from "./render";

/**
 * The board's four aircraft (`PL` in `hud.js`), as the receiver would report them: a position, a track, a
 * callsign, an altitude, a speed and a climb rate. Only inputs. Distances, bearings, the order, the texts and the
 * counts all come from the live code. Each position is `km` and `deg` from you, turned into coordinates.
 */
const BOARD_AIRCRAFT: [km: number, deg: number, track: number, callsign: string, alt: number, kt: number, vrate: number, id: string][] = [
  [0.8, 300, 60, "XQT472", 1800, 150, 1200, "e4810b"],
  [5, 50, 200, "QXA1352", 4500, 210, 0, "a1c3e5"],
  [7.3, 215, 330, "ZKV608", 12000, 300, -1500, "c03f21"],
  [17.5, 320, 110, "JWQ1173", 31000, 450, 0, "7c4a1e"],
];

const me = SAMPLE_OSINT.me!;
/** The sample feed with the board's four aircraft. */
export const DEMO_OSINT: Osint = {
  ...SAMPLE_OSINT,
  aircraft: BOARD_AIRCRAFT.map(([km, deg, track, callsign, alt, kt, vrate, id]) => {
    // The geo code measures distance in metres (111,320 and 110,540 m a degree) and bearing in degrees of
    // latitude and scaled longitude: this solves both for the position that is `km` away on `deg`.
    const sin = Math.sin((deg * Math.PI) / 180);
    const cos = Math.cos((deg * Math.PI) / 180);
    const k = (km * 1000) / Math.hypot(sin * 111_320, cos * 110_540);
    const lat = me.lat + k * cos;
    const lon = me.lon + (k * sin) / Math.cos((me.lat * Math.PI) / 180);
    return { id, callsign, lat, lon, altitude_ft: alt, track, speed_kt: kt, vrate, emergency: false, trail: [] };
  }),
};

/** The same four, as the screen's model has them: what the live code makes of the feed. */
export const BOARD_PLANES: SkyPlane[] = skyPlanes(DEMO_OSINT);

/** Everything the page needs to show one screen state without the server. `now` is the clock's time (the board's 18:16). */
export type Scene = { osint: Osint | null; link: Link; serverError: string | null; nowS: number; now: Date };

/**
 * `?demo=<scene>` on the page URL (a bare `?demo` or `?demo=1` is the live sample):
 * live, empty, nolink, stale, loops (Loops away), nodata, nopos, nokey.
 * The clock is frozen at the sample's time, so the live scene never goes stale.
 * Returns null when the URL has no `demo`, or names a scene that does not exist.
 */
export function demoScene(search: string): Scene | null {
  const params = new URLSearchParams(search);
  if (!params.has("demo")) return null;
  const live: Scene = { osint: DEMO_OSINT, link: "open", serverError: null, nowS: SAMPLE_OSINT.at, now: new Date(2026, 10, 25, 18, 16) };
  switch (params.get("demo")) {
    case "":
    case "1":
    case "live":
      return live;
    case "empty":
      return { ...live, osint: { ...DEMO_OSINT, aircraft: [] } };
    case "nolink":
      return { ...live, link: "closed" };
    case "stale":
      return { ...live, nowS: SAMPLE_OSINT.at + 180 };
    case "loops":
      return { ...live, osint: { ...DEMO_OSINT, connected: false, error: "No answer from the receiver.", aircraft: [] } };
    case "nodata":
      return { ...live, osint: { ...DEMO_OSINT, aircraft: [], missing: ["aircraft"] } };
    case "nopos":
      return { ...live, osint: { ...DEMO_OSINT, me: null } };
    case "nokey":
      return { ...live, link: "closed", serverError: MISSING_KEY_MESSAGE };
    default:
      return null;
  }
}
