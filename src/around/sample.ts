import type { LocalMap, Osint } from "../core/protocol";

/** Made-up sample data for an invented town, set in the open North Atlantic, for the simulator and tests. Not from Loops. */
const C = { lat: 47.2311, lon: -31.4826 };
const at = (dx: number, dy: number): [number, number] => [C.lat + dy / 110_540, C.lon + dx / (111_320 * Math.cos((C.lat * Math.PI) / 180))];
const now = Date.now();

export const SAMPLE_MAP: LocalMap = {
  center: C,
  roads: [
    ...[-480, -360, -240, -120, 0, 120, 240, 360, 480].map((x) => ({ class: "street", points: [at(x, -200), at(x, 700)] })),
    ...[-120, 0, 120, 240, 360, 480].map((y) => ({ class: "street", points: [at(-1500, y), at(1500, y)] })),
    { class: "major", points: [at(-1500, -230), at(-300, -215), at(300, -225), at(1500, -280)] },
    { class: "major", points: [at(-60, 480), at(-180, 700), at(-260, 900)] },
    { class: "rail", points: [at(300, -245), at(1500, -300)] },
    { class: "minor", points: [at(-900, 200), at(-780, 380), at(-700, 600)] },
    { class: "path", points: [at(-1500, -170), at(1500, -180)] },
    { class: "street", points: [at(600, 0), at(900, 300), at(1300, 520)] },
  ],
  water: [[at(-1600, -300), at(1600, -360), at(1600, -1200), at(-1600, -1200), at(-1600, -300)]],
  green: [[at(700, 180), at(1000, 180), at(1000, 420), at(700, 420), at(700, 180)]],
};

export const SAMPLE_OSINT: Osint = {
  connected: true,
  error: null,
  at: now / 1000,
  me: { lat: C.lat, lon: C.lon, source: "gps", area: "Harbour Quarter", heading: 20 },
  items: [
    { id: "a", kind: "accident", severity: 3, title: "Collision, two lanes closed: Long Harbour Avenue", lat: at(260, -222)[0], lon: at(260, -222)[1], area: null, lines: [] },
    { id: "b", kind: "closure", severity: 2, title: "Road closed for works: Silver Street", lat: at(120, 200)[0], lon: at(120, 200)[1], area: null, lines: [[at(120, 0), at(120, 420)]] },
    { id: "c", kind: "transit", severity: 2, title: "Tram 7A delayed about 12 min", lat: at(-300, 300)[0], lon: at(-300, 300)[1], area: null, lines: [] },
    { id: "d", kind: "event", severity: 1, title: "Street market until 19:00: Old Market Square", lat: at(-60, 380)[0], lon: at(-60, 380)[1], area: null, lines: [] },
    { id: "e", kind: "event", severity: 0, title: "Concert tonight: Town Hall Square", lat: at(0, -120)[0], lon: at(0, -120)[1], area: null, lines: [] },
  ],
  aircraft: [
    { id: "a1c3e5", callsign: "QXA1352", lat: C.lat + 0.03, lon: C.lon + 0.05, altitude_ft: 4500, track: 210, speed_kt: 210, emergency: false, trail: [[C.lat + 0.07, C.lon + 0.09], [C.lat + 0.05, C.lon + 0.07]] },
    { id: "c03f21", callsign: "ZKV608", lat: C.lat - 0.06, lon: C.lon - 0.04, altitude_ft: 12000, track: 40, speed_kt: 300, emergency: false, trail: [[C.lat - 0.12, C.lon - 0.09], [C.lat - 0.09, C.lon - 0.06]] },
    { id: "7c4a1e", callsign: "JWQ1173", lat: C.lat + 0.12, lon: C.lon - 0.15, altitude_ft: 31000, track: 160, speed_kt: 450, emergency: false, trail: [] },
    { id: "e4810b", callsign: "XQT472", lat: C.lat + 0.004, lon: C.lon - 0.009, altitude_ft: 1800, track: 30, speed_kt: 150, emergency: false, trail: [[C.lat - 0.01, C.lon - 0.03]] },
  ],
  vehicles: [-500, -200, 100, 400].map((x, i) => ({ lat: at(x, i * 90 - 100)[0], lon: at(x, i * 90 - 100)[1], mode: "tram" })),
};
