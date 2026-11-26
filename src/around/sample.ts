import type { LocalMap, Osint } from "../core/protocol";

/** Made-up sample data for an invented town, set in the open North Atlantic, for the simulator and tests. Not from Loops. */
const C = { lat: 47.2311, lon: -31.4826 };
const at = (dx: number, dy: number): [number, number] => [C.lat + dy / 110_540, C.lon + dx / (111_320 * Math.cos((C.lat * Math.PI) / 180))];
const now = Date.now();

/**
 * The board's city (test/board/hud.cjs, `around.live`), in metres from you: a dotted grid of minor roads, a major
 * road, a waterfront street, a harbour, a park and nine blocks.
 */
const GRID_Y = [-60, 90, 240, 510, 660, 810, 1000, 1250, 1500];
const GRID_X = Array.from({ length: 15 }, (_, i) => -1050 + i * 150);
const BLOCKS = [
  [-420, 120, 90, 70, 60], [-300, 260, 80, 80, 110], [-560, 330, 120, 90, 45], [-190, 440, 70, 60, 150], [-640, 150, 100, 80, 80],
  [130, 500, 90, 70, 90], [330, 420, 110, 70, 60], [-60, 900, 120, 90, 120], [420, 760, 140, 100, 80],
] as const;

export const SAMPLE_MAP: LocalMap & { buildings: { ring: [number, number][]; height: number }[] } = {
  center: C,
  roads: [
    ...GRID_Y.map((y) => ({ class: "minor", points: [at(-1500, y), at(1500, y)] })),
    ...GRID_X.map((x) => ({ class: "minor", points: [at(x, -60), at(x, 1500)] })),
    { class: "major", points: [at(-80, -60), at(-40, 300), at(60, 700), at(200, 1500)] },
    { class: "street", points: [at(-900, 358), at(1700, 340)] },
  ],
  water: [[at(260, 40), at(1700, 40), at(1700, 330), at(260, 330), at(260, 40)]],
  green: [[at(-700, 420), at(-460, 420), at(-460, 640), at(-700, 640), at(-700, 420)]],
  buildings: BLOCKS.map(([x, y, w, d, height]) => ({ ring: [at(x, y), at(x + w, y), at(x + w, y + d), at(x, y + d), at(x, y)], height })),
};

export const SAMPLE_OSINT: Osint = {
  connected: true,
  error: null,
  at: now / 1000,
  me: { lat: C.lat, lon: C.lon, source: "gps", area: "Harbour Quarter", heading: null },
  items: [
    { id: "c", kind: "event", severity: 1, title: "Street market until 19:00", lat: at(-90, 640)[0], lon: at(-90, 640)[1], area: null, lines: [] },
    { id: "b", kind: "roadworks", severity: 2, title: "Road closed for works", lat: at(-250, 180)[0], lon: at(-250, 180)[1], area: null, lines: [] },
    { id: "a", kind: "collision", severity: 3, title: "Collision, two lanes closed", lat: at(140, 420)[0], lon: at(140, 420)[1], area: null, lines: [] },
  ],
  aircraft: [
    { id: "a1c3e5", callsign: "QXA1352", lat: C.lat + 0.03, lon: C.lon + 0.05, altitude_ft: 4500, track: 210, speed_kt: 210, emergency: false, trail: [[C.lat + 0.07, C.lon + 0.09], [C.lat + 0.05, C.lon + 0.07]] },
    { id: "c03f21", callsign: "ZKV608", lat: C.lat - 0.06, lon: C.lon - 0.04, altitude_ft: 12000, track: 40, speed_kt: 300, emergency: false, trail: [[C.lat - 0.12, C.lon - 0.09], [C.lat - 0.09, C.lon - 0.06]] },
    { id: "7c4a1e", callsign: "JWQ1173", lat: C.lat + 0.12, lon: C.lon - 0.15, altitude_ft: 31000, track: 160, speed_kt: 450, emergency: false, trail: [] },
    { id: "e4810b", callsign: "XQT472", lat: at(-520, 900)[0], lon: at(-520, 900)[1], altitude_ft: 1800, track: 60, speed_kt: 150, emergency: false, trail: [[C.lat - 0.01, C.lon - 0.03]] },
  ],
  vehicles: [],
};
