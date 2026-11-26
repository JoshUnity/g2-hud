import { describe, expect, it } from "vitest";
import { calibrate } from "../../src/core/calibrate";
import { LENS, LENS_TILES, STATUS_AT, drawHeader, drawMeter, drawPages, drawTabs, lensCanvas, lensTiles, meterLevels } from "../../src/core/board";
import { drawIcon, type IconGrid } from "../../src/core/icon";
import { Canvas, lv } from "../../src/core/pixels";
import { SPLASH_MARK, SPLASH_NAME_Y, nameBox, renderSplash, splashName, type SplashSpec } from "../../src/core/splash";
import { textWidth } from "../../src/core/text";
import { drawGraph, type Graph3 } from "../../src/core/three";
import { crop, diffFrames } from "./compare";
import { BOARD_ICONS, Oracle, graph, okey } from "./oracle";
import { boardFrame, boardIntroT, type BoardApp } from "./reference";

const sameAsOracle = (o: Oracle, c: Canvas, what: string): void => {
  const d = diffFrames(c.pixels, o.px);
  expect(d, what).toMatchObject({ different: 0 });
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("lens", () => {
  it("is 576 x 288 in four 288 x 144 tiles with ids 1 to 4, as in Around", () => {
    expect(LENS).toEqual({ width: 576, height: 288 });
    expect(LENS_TILES.map((t) => [t.id, t.name, t.x, t.y, t.width, t.height])).toEqual([
      [1, "t00", 0, 0, 288, 144],
      [2, "t10", 288, 0, 288, 144],
      [3, "t01", 0, 144, 288, 144],
      [4, "t11", 288, 144, 288, 144],
    ]);
  });
  it("lensCanvas draws like the board (the last write wins) and lensTiles slices one frame", () => {
    const c = lensCanvas();
    expect([c.width, c.height, c.over]).toEqual([576, 288, true]);
    const tiles = lensTiles(() => Uint8Array.from({ length: 576 * 288 }, (_, i) => (i % 576 >= 288 ? 7 : 3) + (i >= 576 * 144 ? 100 : 0)), () => 1);
    expect(tiles.map((t) => [...new Set(t.render(0))])).toEqual([[3], [7], [103], [107]].map(([v]) => [...new Set(calibrate(Uint8Array.of(v as number)))]));
  });
});

const ICON: IconGrid = ["....####....", "..##....##..", ".#........#.", ".#...##...#.", "#...####...#", "#..######..#", "#..######..#", "#...####...#", ".#...##...#.", ".#........#.", "..##....##..", "....####...."];
const DIM: IconGrid = ICON.map((row, r) => (r === 5 ? row.replace(/#/g, "+") : row));

describe("header, meter, pages, tabs", () => {
  it("drawIcon draws the board's icon(): lit 1, dim .4, a (cell - gap) square at the pitch", () => {
    for (const [cell, gap] of [[2, 0], [3, 1], [8, 2]] as const) {
      const o = new Oracle(200, 120);
      const c = new Canvas(200, 120, true);
      o.icon(DIM, 7, 5, cell, gap);
      drawIcon(c, DIM, 7, 5, cell, gap);
      expect(diffFrames(c.pixels, o.px, { width: 200 }).different, `${cell} ${gap}`).toBe(0);
    }
  });

  it("drawHeader is the board's hdr without its label, with and without an offset", () => {
    for (const [ox, clock] of [[0, "18:16"], [300, "09:05"], [300, "7:4"]] as const) {
      const o = new Oracle();
      const c = lensCanvas();
      o.hdr(DIM, clock, ox);
      drawHeader(c, DIM, clock, ox);
      sameAsOracle(o, c, `${ox} ${clock}`);
    }
    expect(STATUS_AT).toEqual({ x: 32, y: 0, level: 3 });
  });

  it("the header is what the board's own frames show: the icon, the clock and the hairline", () => {
    // (The pixel text after the label, at y 11, is each screen's own.)
    const parts = (ox: number): { x: number; y: number; width: number; height: number }[] => [
      { x: ox, y: 0, width: 26, height: 31 },
      { x: 510, y: 0, width: 66, height: 31 },
      { x: ox, y: 30, width: 576 - ox, height: 1 },
    ];
    for (const [app, ox] of [["around", 0], ["sky", 300]] as const) {
      const c = lensCanvas();
      drawHeader(c, BOARD_ICONS[app]!, "18:16", ox);
      const board = boardFrame(app, "live", 3.3).pixels;
      for (const box of parts(ox)) expect(diffFrames(crop(c.pixels, 576, box), crop(board, 576, box), { width: box.width }), `${app} ${JSON.stringify(box)}`).toMatchObject({ different: 0 });
    }
  });

  it("drawMeter is the board's meter for the board's own levels, and a level maps to a 3 to 13 px bar", () => {
    for (const t of [0, 0.4, 3.3, 7.9]) {
      const o = new Oracle();
      const c = lensCanvas();
      o.meter(484, t);
      drawMeter(c, 484, meterLevels(t));
      sameAsOracle(o, c, `t ${t}`);
    }
    const c = lensCanvas();
    drawMeter(c, 0, [0, 1, 0.5, 0.25]);
    const heights = [0, 1, 2, 3, 4].map((i) => [...Array(30).keys()].filter((y) => (c.pixels[y * 576 + i * 5] ?? 0) > 0).length);
    expect(heights).toEqual([3, 13, 8, 6, 3]);
  });

  it("drawPages is the board's pages", () => {
    for (const [n, cur] of [[2, 0], [3, 1], [5, 4]] as const) {
      const o = new Oracle();
      const c = lensCanvas();
      o.pages(458, n, cur);
      drawPages(c, 458, n, cur);
      sameAsOracle(o, c, `${n} ${cur}`);
    }
  });

  it("drawTabs is the board's tabs for one active and two idle, and a waiting tab is lit", () => {
    const o = new Oracle();
    const c = lensCanvas();
    o.tabs(462);
    drawTabs(c, 462, ["active", "idle", "idle"]);
    sameAsOracle(o, c, "tabs");
    const w = lensCanvas();
    drawTabs(w, 0, ["waiting", "idle"]);
    expect(w.pixels[9 * 576]).toBe(255);
    expect(w.pixels[12 * 576 + 3]).toBe(255);
    expect(w.pixels[10 * 576 + 1]).toBe(0);
    expect(w.pixels[9 * 576 + 12]).toBe(lv(0.55));
  });
});

describe("drawGraph is the board's graph()", () => {
  const random = (seed: number): { oracle: { N: number[][]; E: number[][] }; build: Graph3 } => {
    const r = rng(seed);
    const N = Array.from({ length: 30 }, () => {
      for (;;) {
        const v = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
        if (v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2 <= 1) return v;
      }
    });
    const E = Array.from({ length: 60 }, (): number[] => [Math.floor(r() * 30), Math.floor(r() * 30)]);
    return { oracle: { N, E }, build: { points: N as [number, number, number][], links: E as [number, number][] } };
  };

  it("matches for lit nodes, the focus mark, the mini form, labels and a visibility mask", () => {
    const r = rng(11);
    for (let i = 0; i < 24; i++) {
      const { oracle, build } = random(100 + i);
      const cx = 100 + r() * 300, cy = 80 + r() * 120, sc = 30 + r() * 80, yaw = r() * 7, pit = r() * 1.2 - 0.3;
      const lit = [0, 1, 2, 3].filter(() => r() < 0.7).concat(r() < 0.5 ? [7] : []);
      const mini = i % 3 === 1;
      const withVis = i % 4 === 2;
      const labels = i % 2 ? [null, "PRICING PLAN", "NORTHWIND", "ATLAS MIGRATION"] : undefined;
      const o = new Oracle();
      const c = lensCanvas();
      // The mask the board's vault opening uses: the nearest `share` of the nodes.
      const mask = (P: ({ z: number } | number[])[]): boolean[] => {
        const z = P.map((q) => (Array.isArray(q) ? q[2]! : q.z));
        const idx = z.map((_, k) => k).sort((a, b) => z[b]! - z[a]!);
        const v: boolean[] = [];
        idx.forEach((k, rank) => (v[k] = rank < 17));
        return v;
      };
      const first = graph(o, oracle, cx, cy, sc, yaw, pit, { lit, mini, vis: withVis ? (P) => mask(P) : undefined, labels });
      // Node 0 is the focus on the board when it is lit and the graph is not the mini form.
      const focus = !mini && lit.includes(0) ? 0 : null;
      const pts = drawGraph(c, build, { cx, cy, scale: sc, yaw, pitch: pit }, {
        lit,
        focus,
        vis: withVis ? (P) => mask(P) : undefined,
        labels: labels ? Object.fromEntries(labels.flatMap((s, k) => (s ? [[k, s]] : []))) : undefined,
      });
      expect(pts[0]!.x).toBeCloseTo(first[0]!, 9);
      const d = diffFrames(c.pixels, o.px);
      expect(d, `graph ${i} lit ${lit} mini ${mini} vis ${withVis}`).toMatchObject({ different: 0 });
    }
  });

  it("takes the visibility mask as a list as well", () => {
    const { oracle, build } = random(5);
    const vis = oracle.N.map((_, k) => k % 3 !== 0);
    const o = new Oracle();
    graph(o, oracle, 288, 144, 90, 0.7, 0.3, { lit: [], vis: () => vis });
    const c = lensCanvas();
    drawGraph(c, build, { cx: 288, cy: 144, scale: 90, yaw: 0.7, pitch: 0.3 }, { vis });
    expect(diffFrames(c.pixels, o.px).different).toBe(0);
  });
});

describe("splash against the board", () => {
  const specOf = (app: BoardApp, name: string): SplashSpec => ({ name, icon: BOARD_ICONS[app]!, order: (r, c) => okey(app, r, c) });
  const names: Record<BoardApp, string> = { answers: "Answers", code: "Code", hackos: "HackOS", around: "Around", sky: "Sky" };
  const MARK = { x: SPLASH_MARK.x, y: SPLASH_MARK.y, width: SPLASH_MARK.width, height: SPLASH_MARK.height };

  it("draws the mark and types the name exactly as the board's splash, at many moments of every logo", () => {
    for (const app of Object.keys(names) as BoardApp[]) {
      const spec = specOf(app, names[app]);
      for (let ms = 5; ms < 1600; ms += 37) {
        const board = boardFrame(app, "intro", boardIntroT(ms));
        const build = renderSplash(spec, ms);
        expect(diffFrames(build, crop(board.pixels, LENS.width, MARK), { width: 96 }), `${app} ${ms} ms`).toMatchObject({ different: 0 });
        // Nothing outside the mark but the name.
        const outside = board.pixels.some((v, i) => v > 0 && (i % 576 < MARK.x || i % 576 >= MARK.x + 96 || Math.floor(i / 576) < MARK.y || Math.floor(i / 576) >= MARK.y + 96));
        expect(outside, `${app} ${ms}`).toBe(false);
        const want = splashName(spec, ms);
        if (want.content === "") expect(board.texts, `${app} ${ms}`).toEqual([]);
        else {
          expect(board.texts, `${app} ${ms}`).toEqual([{ text: want.content, x: nameBox(names[app]).x, y: SPLASH_NAME_Y, level: want.color, align: "left" }]);
        }
      }
    }
  });

  it("is the same on the moments the board changes: the pulse and the start of the out phase", () => {
    for (const app of Object.keys(names) as BoardApp[]) {
      const spec = specOf(app, names[app]);
      for (const ms of [0, 1, 899, 901, 1249, 1251, 1299, 1301, 1599]) {
        const board = boardFrame(app, "intro", boardIntroT(ms));
        expect(diffFrames(renderSplash(spec, ms), crop(board.pixels, LENS.width, MARK), { width: 96 }), `${app} ${ms}`).toMatchObject({ different: 0 });
      }
    }
  });

  it("puts the name where the board puts it, centred by the glasses width", () => {
    for (const app of Object.keys(names) as BoardApp[]) {
      expect(nameBox(names[app]).x).toBe(Math.round((576 - textWidth(names[app])) / 2));
    }
  });
});

describe("the board's icons are the build's", () => {
  it("has the same marks and the same build order in every app", async () => {
    const modules = {
      answers: await import("../../src/answers/icon"),
      code: await import("../../src/code/icon"),
      hackos: await import("../../src/hackos/icon"),
      around: await import("../../src/around/icon"),
      sky: await import("../../src/sky/icon"),
    };
    for (const app of Object.keys(modules) as BoardApp[]) {
      const m = modules[app];
      expect([...m.ICON], app).toEqual(BOARD_ICONS[app]);
      for (let r = 0; r < 12; r++) for (let c = 0; c < 12; c++) if (BOARD_ICONS[app]![r]![c] === "#") expect(m.ORDER(r, c), `${app} ${r} ${c}`).toBeCloseTo(okey(app, r, c), 12);
    }
  });
});
