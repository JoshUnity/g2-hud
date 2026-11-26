import { describe, expect, it } from "vitest";
import { GLYPHS } from "../../src/core/font5x7";
import { Canvas, lv } from "../../src/core/pixels";
import { project, rotate } from "../../src/core/three";
import { BOARD_FONT, Oracle, pr, rot } from "./oracle";

/** Each Canvas primitive against the board's own body, with the same random inputs: the same pixels, level for level. */

const W = 160;
const H = 120;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const levels = (c: Canvas): number[] => [...c.pixels].map((v) => Math.round(v / 17));
const pair = (): [Oracle, Canvas] => [new Oracle(W, H), new Canvas(W, H, true)];
/** An alpha the board uses: 0 to 1 in any step, or none. */
const alpha = (r: () => number): number | undefined => (r() < 0.1 ? undefined : r() < 0.15 ? 0 : r());
const val = (a: number | undefined): number => lv(a ?? 1);
const same = (o: Oracle, c: Canvas, what: string): void => expect(levels(c), what).toEqual([...o.px]);

describe("lv", () => {
  it("is the 0-255 value of the board's level", () => {
    expect(lv(1)).toBe(255);
    expect(lv(0)).toBe(0);
    expect(lv(0.4)).toBe(102);
    expect(lv(0.72)).toBe(187);
    expect(lv(0.85)).toBe(221);
    for (let a = 0; a <= 1; a += 0.013) expect(Math.round(lv(a) / 17)).toBe(Math.round(a * 15));
    expect(lv(2)).toBe(255);
    expect(lv(-1)).toBe(0);
  });
});

describe("rectangles and clears", () => {
  it("p: rounds X and Y, defaults to 1 px, and 0 means 1; the last write wins", () => {
    const r = rng(1);
    const [o, c] = pair();
    for (let i = 0; i < 400; i++) {
      const X = r() * 200 - 20, Y = r() * 160 - 20, a = alpha(r);
      const w = r() < 0.2 ? undefined : Math.floor(r() * 12), h = r() < 0.2 ? undefined : Math.floor(r() * 12);
      o.p(X, Y, a, w, h);
      c.p(X, Y, val(a), w, h);
    }
    same(o, c, "p");
  });
  it("rect and plot: rounded origin, whole pixels", () => {
    const r = rng(2);
    const [o, c] = pair();
    for (let i = 0; i < 300; i++) {
      const X = r() * 180 - 10, Y = r() * 140 - 10, a = alpha(r), w = 1 + Math.floor(r() * 9), h = 1 + Math.floor(r() * 9);
      o.p(X, Y, a, w, h);
      c.rect(X, Y, w, h, val(a));
      o.p(X + 3, Y + 1, a);
      c.plot(Math.round(X + 3), Math.round(Y + 1), val(a));
    }
    same(o, c, "rect");
  });
  it("cl and clearRect clear to black, clipped", () => {
    const r = rng(3);
    const [o2, c2] = pair();
    for (let i = 0; i < 200; i++) {
      const X = r() * W, Y = r() * H, w = 1 + Math.floor(r() * 40), h = 1 + Math.floor(r() * 30);
      if (i % 2) { o2.p(X, Y, 1, w, h); c2.rect(X, Y, w, h, 255); }
      else { const cx = r() * 200 - 20, cy = r() * 160 - 20; o2.cl(cx, cy, w, h); c2.clearRect(cx, cy, w, h); }
    }
    same(o2, c2, "cl");
  });
  it("box and roundRect", () => {
    const r = rng(4);
    const [o, c] = pair();
    for (let i = 0; i < 200; i++) {
      const X = r() * 180 - 10, Y = r() * 140 - 10, a = alpha(r), w = 8 + Math.floor(r() * 60), h = 8 + Math.floor(r() * 50);
      if (i % 2) { o.box(X, Y, w, h, a); c.box(X, Y, w, h, val(a)); }
      else {
        const rad = Math.floor(r() * Math.min(w, h) / 2);
        o.rr(X, Y, w, h, rad, a);
        c.roundRect(X, Y, w, h, rad, val(a));
      }
    }
    same(o, c, "box and rr");
  });
});

describe("lines", () => {
  it("line and dashed: the same Bresenham ties and dash phase, for either end point first", () => {
    const r = rng(5);
    const [o, c] = pair();
    for (let i = 0; i < 1200; i++) {
      const frac = i % 3 === 0;
      const q = (n: number): number => (frac ? r() * n - 30 : Math.floor(r() * n) - 30);
      const [x0, y0, x1, y1] = [q(W + 60), q(H + 60), q(W + 60), q(H + 60)];
      const a = alpha(r);
      const on = 1 + Math.floor(r() * 4), off = 1 + Math.floor(r() * 4);
      const kind = i % 4;
      if (kind === 0) { o.ln(x0, y0, x1, y1, a); c.line(x0, y0, x1, y1, val(a)); }
      else if (kind === 1) { o.ln(x1, y1, x0, y0, a); c.line(x1, y1, x0, y0, val(a)); }
      else if (kind === 2) { o.ln(x0, y0, x1, y1, a, [on, off]); c.dashed(x0, y0, x1, y1, val(a), on, off); }
      else { o.ln(x1, y1, x0, y0, a, [on, off]); c.dashed(x1, y1, x0, y0, val(a), on, off); }
    }
    same(o, c, "lines");
  });
  it("covers ties on every slope of a small grid, one line at a time", () => {
    for (let dx = -9; dx <= 9; dx++) {
      for (let dy = -9; dy <= 9; dy++) {
        for (const pattern of [undefined, [1, 2] as [number, number], [3, 2] as [number, number]]) {
          const [o, c] = pair();
          o.ln(60, 60, 60 + dx, 60 + dy, 1, pattern);
          if (pattern) c.dashed(60, 60, 60 + dx, 60 + dy, 255, pattern[0], pattern[1]);
          else c.line(60, 60, 60 + dx, 60 + dy, 255);
          same(o, c, `${dx} ${dy} ${pattern}`);
        }
      }
    }
  });
});

describe("circles", () => {
  it("circle and disc (ci) and kod (knockout)", () => {
    const r = rng(6);
    const [o, c] = pair();
    for (let i = 0; i < 300; i++) {
      const cx = r() * 200 - 20, cy = r() * 160 - 20, rad = Math.floor(r() * 30), a = alpha(r);
      const kind = i % 3;
      if (kind === 0) { o.ci(cx, cy, rad, a); c.circle(cx, cy, rad, val(a)); }
      else if (kind === 1) { o.ci(cx, cy, rad, a, true); c.disc(cx, cy, rad, val(a)); }
      else { o.kod(cx, cy, rad); c.knockout(cx, cy, rad); }
    }
    same(o, c, "circles");
  });
});

describe("text", () => {
  it("has the board's bitmap for every character the board has", () => {
    for (const [char, rows] of Object.entries(BOARD_FONT)) {
      const bits = [...rows].map((d) => parseInt(d, 32).toString(2).padStart(5, "0"));
      expect(GLYPHS[char], char).toEqual(bits);
    }
  });
  it("pf, pw, pfr, pfc and label: same pixels, advance and rounding", () => {
    const r = rng(7);
    const chars = Object.keys(BOARD_FONT).join("") + "abcxyz ";
    const word = (): string => Array.from({ length: 1 + Math.floor(r() * 12) }, () => chars[Math.floor(r() * chars.length)]).join("");
    const [o, c] = pair();
    for (let i = 0; i < 400; i++) {
      const s = word(), X = r() * 200 - 20, Y = r() * 130 - 5, a = alpha(r), sc = 1 + Math.floor(r() * 5), dots = r() < 0.4;
      expect(Canvas.textWidth(s, sc)).toBe(o.pw(s, sc));
      const kind = i % 4;
      if (kind === 0) { o.pf(s, X, Y, sc, a, dots); c.text(X, Y, s, val(a), sc, dots); }
      else if (kind === 1) { o.pfr(s, X, Y, sc, a, dots); c.textRight(X, Y, s, val(a), sc, dots); }
      else if (kind === 2) { o.pfc(s, X, Y, sc, a, dots); c.textCenter(X, Y, s, val(a), sc, dots); }
      else { o.label(s, X, Y, a); c.label(X, Y, s, val(a)); }
    }
    same(o, c, "text");
  });
  it("draws nothing for a space and keeps the advance", () => {
    const [o, c] = pair();
    o.pf("A B", 3, 3, 2, 1);
    expect(c.text(3, 3, "A B", 255, 2)).toBe(36);
    same(o, c, "A B");
    expect(Canvas.textWidth("A B", 2)).toBe(o.pw("A B", 2));
  });
});

describe("over and additive", () => {
  it("over lets a dim write replace a bright one and a 0 write black; additive keeps the brighter", () => {
    const over = new Canvas(4, 1, true);
    over.plot(1, 0, 255);
    over.plot(1, 0, 51);
    over.plot(2, 0, 255);
    over.plot(2, 0, 0);
    expect([...over.pixels]).toEqual([0, 51, 0, 0]);
    const add = new Canvas(4, 1);
    add.plot(1, 0, 255);
    add.plot(1, 0, 51);
    expect([...add.pixels]).toEqual([0, 255, 0, 0]);
  });
});

describe("3D", () => {
  it("rotate and project are the board's rot and pr", () => {
    const r = rng(8);
    for (let i = 0; i < 200; i++) {
      const v: [number, number, number] = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const yaw = r() * 7, pit = r() * 2 - 1;
      expect(rotate(v, yaw, pit)).toEqual(rot(v, yaw, pit));
      const q = rotate(v, yaw, pit);
      const want = pr(q, 144, 100, 60);
      expect(Object.values(project(q, 144, 100, 60))).toEqual(want);
    }
  });
});
