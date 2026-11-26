import { describe, expect, it } from "vitest";
import { demoScene } from "../src/around/demo";
import { incidentRows, BAND_Y, BLOCK_CAP, BLOCK_RANGE, H, W, clipSegment, distanceText, drawable, easeLoad, frontLabel, frontRow, lens, pageCount, renderAround } from "../src/around/render";
import { SAMPLE_MAP, SAMPLE_OSINT } from "../src/around/sample";
import type { LocalMap } from "../src/core/protocol";
import { sameFrame } from "../src/core/pixels";

const lit = (frame: Uint8Array, x0: number, y0: number, w: number, h: number): number => {
  let n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if ((frame[y * W + x] ?? 0) > 0) n++;
  return n;
};

describe("Around projection", () => {
  it("puts you at the foot of the lens and the far ground at the horizon", () => {
    const [x, y] = lens(0, 0);
    expect([x, Math.round(y)]).toEqual([288, 196]);
    expect(lens(0, 1e6)[1]).toBeCloseTo(44, 1);
    expect(lens(100, 400)[0]).toBeGreaterThan(288);
    // A thing 70 m tall is drawn higher than its foot.
    expect(lens(0, 400, 70)[1]).toBeLessThan(lens(0, 400)[1]);
  });
  it("cuts a segment at the near plane and the far limit", () => {
    expect(clipSegment([0, -500], [0, -100], -40, 1600)).toBeNull();
    const cut = clipSegment([0, -100], [0, 3000], -40, 1600);
    expect(cut?.[0][1]).toBeCloseTo(-40);
    expect(cut?.[1][1]).toBeCloseTo(1600);
    expect(clipSegment([5, 10], [5, 20], -40, 1600)).toEqual([[5, 10], [5, 20]]);
  });
});

describe("Around picture", () => {
  const map = SAMPLE_MAP;
  const frame = renderAround(map, SAMPLE_OSINT, 0);

  it("is 576 x 288, with the header and band cleared of the map", () => {
    expect(frame).toHaveLength(W * H);
    // Above the header hairline only the icon, the counts and nothing of the ground.
    expect(lit(frame, 60, 0, 100, 28)).toBe(0);
    expect(lit(frame, 0, 2, 24, 24)).toBeGreaterThan(40);
    expect(lit(frame, 0, 30, W, 1)).toBe(W);
    expect(lit(frame, 0, BAND_Y, W, 1)).toBe(W);
  });
  it("draws you, the horizon and the heading tape", () => {
    expect(lit(frame, 280, 190, 16, 14)).toBeGreaterThan(30);
    expect(lit(frame, 0, 44, W, 1)).toBeGreaterThan(150);
    expect(lit(frame, 280, 33, 16, 7)).toBeGreaterThan(8);
  });
  it("shows a badge and a distance for each row, and no pager for two rows", () => {
    expect(lit(frame, 0, 240, 11, 11)).toBeGreaterThan(80);
    expect(lit(frame, 490, 239, 60, 14)).toBeGreaterThan(40);
    expect(lit(frame, 540, 229, 32, 7)).toBe(0);
  });
  it("pages three rows, 1/2 at the top right", () => {
    const extra = { ...SAMPLE_OSINT.items[2]!, id: "x", severity: 2 };
    const three = { ...SAMPLE_OSINT, items: [...SAMPLE_OSINT.items, extra] };
    const first = renderAround(map, three, 0);
    expect(lit(first, 540, 229, 32, 7)).toBeGreaterThan(5);
    expect(pageCount(3)).toBe(2);
    const last = renderAround(map, three, 0, 1);
    expect(sameFrame(last, first)).toBe(false);
    // One row on the last page: nothing at the second row.
    expect(lit(last, 0, 259, 11, 27)).toBe(0);
  });
  it("renders a still scene identically, and only the pulse ring moves", () => {
    const quiet = { ...SAMPLE_OSINT, items: SAMPLE_OSINT.items.filter((i) => i.severity < 3) };
    expect(sameFrame(renderAround(map, quiet, 0), renderAround(map, quiet, 2.5))).toBe(true);
    expect(sameFrame(renderAround(map, SAMPLE_OSINT, 0), renderAround(map, SAMPLE_OSINT, 1))).toBe(false);
  });
  it("uses flat values only: a handful of levels, no soft edges", () => {
    // The glasses keep 16 levels; this picture asks for far fewer than that after quantising.
    expect(new Set([...frame].map((v) => Math.round(v / 17))).size).toBeLessThanOrEqual(14);
    expect(new Set(frame).size).toBeLessThanOrEqual(24);
  });
  it("draws nothing that moves, and no counts, when the feed is not live", () => {
    const view = drawable(SAMPLE_OSINT, false);
    const still = renderAround(map, view, 0, 0, false);
    expect(lit(still, 0, 232, W, 54)).toBe(0);
    expect(lit(still, 46, 5, 300, 20)).toBe(0);
    expect(sameFrame(still, renderAround(map, view, 2, 0, false))).toBe(true);
  });
  it("draws no map without a position", () => {
    const none = renderAround(null, { ...SAMPLE_OSINT, me: null }, 0);
    expect(lit(none, 0, 44, W, 180)).toBeGreaterThan(0);
    expect(lit(none, 0, 44, W, 90)).toBe(0);
    expect(lit(none, 280, 33, 16, 7)).toBe(0);
  });
});

describe("Around demo scenes", () => {
  it("has each scene", () => {
    expect(demoScene("1").osint?.items).toHaveLength(3);
    expect(incidentRows(demoScene("1").osint)).toHaveLength(2);
    expect(demoScene("quiet").osint?.items).toEqual([]);
    expect(demoScene("nolink").link).toBe("closed");
    expect(demoScene("stale").osint?.at).toBeLessThan(SAMPLE_OSINT.at - 100);
    expect(demoScene("nofix").osint?.me).toBeNull();
    expect(demoScene("nofix").map).toBeNull();
    expect(demoScene("anything").link).toBe("open");
  });
  it("reads distances short", () => {
    expect(distanceText(340)).toBe("340M");
    expect(distanceText(997)).toBe("1.0KM");
    expect(distanceText(2340)).toBe("2.3KM");
  });
});

describe("Around depth load", () => {
  const full = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 0);
  const rowsEqual = (a: Uint8Array, b: Uint8Array, y0: number, y1: number): boolean => sameFrame(a.subarray(y0 * W, y1 * W), b.subarray(y0 * W, y1 * W));

  it("at reveal 1 is the normal picture", () => {
    expect(sameFrame(renderAround(SAMPLE_MAP, SAMPLE_OSINT, 0, 0, true, 1), full)).toBe(true);
  });
  it("runs the front from your feet to the horizon, eased", () => {
    expect(frontRow(0)).toBe(226);
    expect(frontRow(1)).toBe(44);
    expect(easeLoad(0.5)).toBe(0.5);
    expect(easeLoad(0.25)).toBeLessThan(0.25);
  });
  it("names the distance of the front", () => {
    expect(frontLabel(226)).toBe("0M");
    expect(frontLabel(frontRow(0.5))).toMatch(/^[0-9]+M$/);
    expect(frontLabel(60)).toMatch(/^[0-9.]+KM$/);
    expect(frontLabel(frontRow(0.5))).toBe(`${Math.round((33440 / (frontRow(0.5) - 44) - 220) / 10) * 10}M`);
  });
  it("keeps the ground above the front dark except what stands up, and the rest is final", () => {
    const part = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 0, 0, true, 0.5);
    const yL = frontRow(0.5);
    // Rows below the trailing lines are the final picture.
    expect(rowsEqual(part, full, yL + 8, BAND_Y)).toBe(true);
    // The front is a bright dotted row.
    expect(lit(part, 0, yL, W, 1)).toBeGreaterThanOrEqual(W / 2);
    // Above it: no ground texture (only the "MAPPING" and distance boxes and risers, so far fewer lit pixels than final).
    expect(lit(part, 0, 45, W, yL - 45 - 12)).toBeLessThan(lit(full, 0, 45, W, yL - 45 - 12) / 4);
  });
  it("does not draw a beacon before the front has passed its foot", () => {
    const only = { ...SAMPLE_OSINT, aircraft: [], vehicles: [], items: SAMPLE_OSINT.items.slice(0, 1) };
    const [, gy] = lens(140, 310);
    const early = renderAround(SAMPLE_MAP, only, 0, 0, true, 0.2);
    expect(frontRow(0.2)).toBeGreaterThan(gy);
    const late = renderAround(SAMPLE_MAP, only, 0, 0, true, 0.9);
    expect(frontRow(0.9)).toBeLessThan(gy);
    // The collision diamond sits about 70 m above its foot; it is only in the late frame.
    const [tx, ty] = lens(140, 310, 70);
    expect(lit(early, Math.round(tx) - 6, Math.round(ty) - 12, 13, 12)).toBe(0);
    expect(lit(late, Math.round(tx) - 6, Math.round(ty) - 12, 13, 12)).toBeGreaterThan(20);
  });
  it("leaves the header and the bottom band complete from the start", () => {
    const start = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 0, 0, true, 0);
    expect(rowsEqual(start, full, 0, 44)).toBe(true);
    expect(rowsEqual(start, full, BAND_Y + 1, H)).toBe(true);
  });
});

describe("Around blocks", () => {
  const { buildings: _all, ...flat } = SAMPLE_MAP;
  const bare = renderAround(flat as LocalMap, SAMPLE_OSINT, 0);
  const full = renderAround(SAMPLE_MAP, SAMPLE_OSINT, 0);
  const at = (dx: number, dy: number): [number, number] => {
    const c = SAMPLE_MAP.center;
    return [c.lat + dy / 110_540, c.lon + dx / (111_320 * Math.cos((c.lat * Math.PI) / 180))];
  };
  const box = (x: number, y: number, w = 60, d = 60, height = 80) => ({ ring: [at(x, y), at(x + w, y), at(x + w, y + d), at(x, y + d), at(x, y)], height });
  const withBlocks = (buildings: ReturnType<typeof box>[]) => renderAround({ ...flat, buildings } as LocalMap, SAMPLE_OSINT, 0);
  const near = ([lat, lon]: [number, number]): number => {
    const c = SAMPLE_MAP.center;
    return Math.hypot((lon - c.lon) * 111_320 * Math.cos((c.lat * Math.PI) / 180), (lat - c.lat) * 110_540);
  };
  const changed = (a: Uint8Array, b: Uint8Array): number => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

  it("draws no blocks when the map has none", () => {
    expect(sameFrame(renderAround({ ...flat, buildings: [] } as LocalMap, SAMPLE_OSINT, 0), bare)).toBe(true);
  });
  it("lights the block pixels when it has them", () => {
    expect(changed(full, bare)).toBeGreaterThan(300);
  });
  it("skips a building behind you, or beyond the limit", () => {
    expect(sameFrame(withBlocks([box(-30, -300)]), bare)).toBe(true);
    expect(sameFrame(withBlocks([box(-30, BLOCK_RANGE + 200)]), bare)).toBe(true);
    expect(changed(withBlocks([box(-130, 500)]), bare)).toBeGreaterThan(30);
  });
  it("draws at most the cap: the nearest blocks", () => {
    const all = Array.from({ length: 55 }, (_, i) => box(-200 + (i % 11) * 40, 40 + Math.floor(i / 11) * 40, 20, 20, 30));
    const nearest = [...all].sort((a, b) => Math.min(...a.ring.map(near)) - Math.min(...b.ring.map(near))).slice(0, BLOCK_CAP);
    expect(sameFrame(withBlocks(all), withBlocks(nearest))).toBe(true);
    expect(sameFrame(withBlocks(all), withBlocks(all.slice(0, BLOCK_CAP + 5)))).toBe(false);
  });
  it("keeps still frames identical", () => {
    const quiet = { ...SAMPLE_OSINT, items: [] };
    expect(sameFrame(renderAround(SAMPLE_MAP, quiet, 0), renderAround(SAMPLE_MAP, quiet, 3))).toBe(true);
  });
  it("appears behind the load front, not before", () => {
    const b = [box(-130, 500)];
    const early = renderAround({ ...flat, buildings: b } as LocalMap, SAMPLE_OSINT, 0, 0, true, 0.1);
    const none = renderAround(flat as LocalMap, SAMPLE_OSINT, 0, 0, true, 0.1);
    expect(sameFrame(early, none)).toBe(true);
    const late = renderAround({ ...flat, buildings: b } as LocalMap, SAMPLE_OSINT, 0, 0, true, 0.9);
    expect(sameFrame(late, renderAround(flat as LocalMap, SAMPLE_OSINT, 0, 0, true, 0.9))).toBe(false);
  });
});
