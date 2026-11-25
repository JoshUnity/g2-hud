import { readFileSync } from "node:fs";

/**
 * The board engine's primitives, ported line by line from `hud.cjs` onto a grid of grey levels, as the oracle for
 * the primitive tests. (The engine itself only exports `draw`, so a primitive cannot be called alone.) Keep each
 * body the same as the engine's: a change here must come from a change of the board.
 */

const SOURCE = readFileSync(new URL("./hud.cjs", import.meta.url), "utf8");
const W = 576;
const H = 288;

/** The engine's FONT table, read from its source so it can never drift. */
export const BOARD_FONT: Record<string, string> = (() => {
  const m = /var FONT=(\{[\s\S]*?\});\nfunction pf/.exec(SOURCE);
  if (!m) throw new Error("hud.cjs has no FONT table.");
  return new Function(`return (${m[1]})`)() as Record<string, string>;
})();

export class Oracle {
  readonly px: Uint8Array;
  KO = false;

  constructor(readonly width = W, readonly height = H) {
    this.px = new Uint8Array(width * height);
  }

  private fillRect(x: number, y: number, w: number, h: number, level: number): void {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) this.px[j * this.width + i] = level;
  }

  p(X: number, Y: number, a?: number | null, w?: number, h?: number): void {
    this.fillRect(Math.round(X), Math.round(Y), w || 1, h || 1, this.KO ? 0 : Math.round((a == null ? 1 : a) * 15));
  }
  cl(X: number, Y: number, w: number, h: number): void {
    this.fillRect(Math.round(X), Math.round(Y), w, h, 0);
  }
  ln(x0: number, y0: number, x1: number, y1: number, a?: number, d?: [number, number] | null): void {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 5000) return;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy, i = 0;
    for (;;) {
      if (!d || i % (d[0] + d[1]) < d[0]) this.p(x0, y0, a);
      i++;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  ci(cx: number, cy: number, r: number, a?: number, fill?: boolean): void {
    cx = Math.round(cx); cy = Math.round(cy);
    let X = r, Y = 0, e = 1 - r;
    while (X >= Y) {
      if (fill) {
        this.p(cx - X, cy + Y, a, 2 * X + 1, 1); this.p(cx - X, cy - Y, a, 2 * X + 1, 1);
        this.p(cx - Y, cy + X, a, 2 * Y + 1, 1); this.p(cx - Y, cy - X, a, 2 * Y + 1, 1);
      } else {
        this.p(cx + X, cy + Y, a); this.p(cx + Y, cy + X, a); this.p(cx - X, cy + Y, a); this.p(cx - Y, cy + X, a);
        this.p(cx + X, cy - Y, a); this.p(cx + Y, cy - X, a); this.p(cx - X, cy - Y, a); this.p(cx - Y, cy - X, a);
      }
      Y++;
      if (e < 0) e += 2 * Y + 1;
      else { X--; e += 2 * (Y - X) + 1; }
    }
  }
  kod(cx: number, cy: number, r: number): void {
    this.KO = true; this.ci(cx, cy, r, 1, true); this.KO = false;
  }
  box(X: number, Y: number, w: number, h: number, a?: number): void {
    this.p(X, Y, a, w, 1); this.p(X, Y + h - 1, a, w, 1); this.p(X, Y, a, 1, h); this.p(X + w - 1, Y, a, 1, h);
  }
  rr(X: number, Y: number, Wd: number, Ht: number, r: number, a?: number): void {
    this.p(X + r, Y, a, Wd - 2 * r, 1); this.p(X + r, Y + Ht - 1, a, Wd - 2 * r, 1);
    this.p(X, Y + r, a, 1, Ht - 2 * r); this.p(X + Wd - 1, Y + r, a, 1, Ht - 2 * r);
    let u = r, v = 0, e = 1 - r;
    while (u >= v) {
      for (const [A, B] of [[u, v], [v, u]] as const) {
        this.p(X + r - A, Y + r - B, a); this.p(X + Wd - 1 - r + A, Y + r - B, a);
        this.p(X + r - A, Y + Ht - 1 - r + B, a); this.p(X + Wd - 1 - r + A, Y + Ht - 1 - r + B, a);
      }
      v++;
      if (e < 0) e += 2 * v + 1;
      else { u--; e += 2 * (v - u) + 1; }
    }
  }
  pf(s: string, X: number, Y: number, sc: number, a?: number, dots?: boolean): void {
    s = String(s).toUpperCase();
    let cx = Math.round(X);
    const d = dots ? sc - 1 : sc;
    Y = Math.round(Y);
    for (let i = 0; i < s.length; i++) {
      const g = BOARD_FONT[s.charAt(i)];
      if (g)
        for (let r = 0; r < 7; r++) {
          const v = parseInt(g.charAt(r), 32);
          for (let c = 0; c < 5; c++) if (v & (16 >> c)) this.p(cx + c * sc, Y + r * sc, a, d, d);
        }
      cx += 6 * sc;
    }
  }
  pw(s: string, sc: number): number {
    return String(s).length * 6 * sc - sc;
  }
  pfr(s: string, XR: number, Y: number, sc: number, a?: number, dots?: boolean): void {
    this.pf(s, XR - this.pw(s, sc), Y, sc, a, dots);
  }
  pfc(s: string, XC: number, Y: number, sc: number, a?: number, dots?: boolean): void {
    this.pf(s, XC - this.pw(s, sc) / 2, Y, sc, a, dots);
  }
  label(s: string, X: number, Y: number, a?: number): void {
    const w = this.pw(s, 1);
    this.cl(X - 2, Y - 2, w + 4, 11);
    this.pf(s, X, Y, 1, a);
  }
  icon(g: readonly string[], X: number, Y: number, s: number, gap?: number): void {
    for (let r = 0; r < 12; r++)
      for (let c = 0; c < 12; c++) {
        const v = g[r]?.charAt(c);
        if (v !== ".") this.p(X + c * s, Y + r * s, v === "#" ? 1 : 0.4, s - (gap || 0), s - (gap || 0));
      }
  }
  /** `hdr` without its status text, with the clock given. */
  hdr(g: readonly string[], clock: string, ox = 0): void {
    this.icon(g, ox, 2, 2);
    this.pfr(clock, W, 7, 2, 0.8);
    this.p(ox, 30, 0.3, W - ox, 1);
  }
  meter(X: number, T: number): void {
    for (let i = 0; i < 5; i++) {
      const h = 3 + Math.round(10 * Math.abs(Math.sin(T * 3.1 + i * 1.7) * Math.sin(T * 0.9 + i)));
      this.p(X + i * 5, 22 - h, 0.85, 3, h);
    }
  }
  pages(X: number, n: number, cur: number): void {
    for (let i = 0; i < n; i++) {
      if (i === cur) this.p(X + i * 10, 10, 1, 6, 6);
      else this.box(X + i * 10, 10, 6, 6, 0.55);
    }
  }
  tabs(X: number): void {
    this.p(X, 9, 1, 8, 8); this.box(X + 12, 9, 8, 8, 0.55); this.box(X + 24, 9, 8, 8, 0.55);
  }
}

/** The engine's `rot` and `pr`. */
export function rot(v: number[], yaw: number, pit: number): number[] {
  let c = Math.cos(yaw), s = Math.sin(yaw);
  const x1 = v[0]! * c + v[2]! * s, z1 = -v[0]! * s + v[2]! * c;
  c = Math.cos(pit); s = Math.sin(pit);
  return [x1, v[1]! * c - z1 * s, v[1]! * s + z1 * c];
}
export function pr(v: number[], cx: number, cy: number, sc: number): number[] {
  const k = 3.4 / (3.4 + v[2]!);
  return [cx + v[0]! * sc * k, cy - v[1]! * sc * k, v[2]!];
}

export type OracleGraph = { N: number[][]; E: number[][] };
export type OracleGraphOptions = { lit?: number[]; mini?: boolean; vis?: (P: number[][]) => boolean[]; labels?: (string | null)[] };

/** The engine's `graph()`. Returns the first projected point. */
export function graph(o: Oracle, g: OracleGraph, cx: number, cy: number, sc: number, yaw: number, pit: number, opt: OracleGraphOptions = {}): number[] {
  const P = g.N.map((n) => pr(rot(n, yaw, pit), cx, cy, sc));
  const lit = opt.lit || [0, 1, 2, 3];
  const on = (i: number): boolean => lit.indexOf(i) >= 0;
  const vis = opt.vis ? opt.vis(P) : null;
  g.E.forEach((e) => {
    if (vis && (!vis[e[0]!] || !vis[e[1]!])) return;
    const a = P[e[0]!]!, b = P[e[1]!]!, z = (a[2]! + b[2]!) / 2;
    if (on(e[0]!) && on(e[1]!)) o.ln(a[0]!, a[1]!, b[0]!, b[1]!, 1);
    else o.ln(a[0]!, a[1]!, b[0]!, b[1]!, z < -0.2 ? 0.45 : z < 0.35 ? 0.3 : 0.22, z < 0.35 ? null : [1, 2]);
  });
  P.forEach((q, i) => {
    if (vis && !vis[i]) return;
    const z = q[2]!;
    if (on(i)) {
      if (i === 0 && !opt.mini) {
        o.kod(q[0]!, q[1]!, 9); o.p(q[0]! - 2, q[1]! - 2, 1, 5, 5); o.ci(q[0]!, q[1]!, 8, 1);
        o.p(q[0]! - 12, q[1]!, 1, 3, 1); o.p(q[0]! + 10, q[1]!, 1, 3, 1); o.p(q[0]!, q[1]! - 12, 1, 1, 3); o.p(q[0]!, q[1]! + 10, 1, 1, 3);
      } else {
        o.cl(q[0]! - 3, q[1]! - 3, 7, 7); o.p(q[0]! - 2, q[1]! - 2, 1, 5, 5);
      }
    } else if (z < -0.3) o.p(q[0]! - 1, q[1]! - 1, 0.8, 3, 3);
    else if (z < 0.4) o.p(q[0]! - 1, q[1]! - 1, 0.55, 2, 2);
    else o.p(q[0]!, q[1]!, 0.45);
  });
  if (opt.labels) opt.labels.forEach((s, i) => { if (s) o.label(s, P[i]![0]! + 8, P[i]![1]! - 3, 0.85); });
  return P[0]!;
}

/** The engine's icons (`IC`) and the order each mark builds in (`okey`), taken from its source, for the splash. */
export const BOARD_ICONS = new Function(`return (${/var IC=(\{[\s\S]*?\});\nvar NAME/.exec(SOURCE)![1]})`)() as Record<string, string[]>;
export const okey = new Function(`${/function okey[\s\S]*?\nfunction splash/.exec(SOURCE)![0].replace(/function splash$/, "")}; return okey;`)() as (a: string, r: number, c: number) => number;
