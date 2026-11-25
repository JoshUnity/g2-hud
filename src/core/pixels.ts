/**
 * A tiny raster library for the G2's image containers: 8-bit grey in memory,
 * quantised by the glasses to 16 levels. Everything is additive light: the
 * brightest value at a pixel wins, black is the clear lens.
 */
import { GLYPHS, GLYPH_H, GLYPH_W } from "./font5x7";

/** 4 x 4 ordered dither, for textures (water, parks) that read as "material". */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export type Texture = "solid" | "dither" | "dots" | "hatch";

export class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height);
  }

  plot(x: number, y: number, value: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    const v = Math.min(255, Math.max(0, Math.round(value)));
    if (v > (this.pixels[i] ?? 0)) this.pixels[i] = v;
  }

  /** Anti-aliased line (Xiaolin Wu), so edges use the in-between grey levels. */
  line(x0: number, y0: number, x1: number, y1: number, value: number): void {
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) [x0, y0, x1, y1] = [y0, x0, y1, x1];
    if (x0 > x1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    const dx = x1 - x0;
    const gradient = dx === 0 ? 1 : (y1 - y0) / dx;
    let y = y0 + gradient * (Math.round(x0) - x0);
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const base = Math.floor(y);
      const frac = y - base;
      if (steep) {
        this.plot(base, x, value * (1 - frac));
        this.plot(base + 1, x, value * frac);
      } else {
        this.plot(x, base, value * (1 - frac));
        this.plot(x, base + 1, value * frac);
      }
      y += gradient;
    }
  }

  /**
   * A line drawn in dashes: `on` pixels lit, `off` dark, along its length.
   * `phase` is how far into the pattern the line starts; the return value is
   * the phase at its end, so a polyline keeps one pattern across its vertices.
   */
  dashed(x0: number, y0: number, x1: number, y1: number, value: number, on = 2, off = 2, phase = 0): number {
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length === 0) return phase;
    const period = on + off;
    const ux = (x1 - x0) / length;
    const uy = (y1 - y0) / length;
    for (let d = -phase; d < length; d += period) {
      if (on <= 1) {
        // A single lit pixel; a 1 px "line" would light both of its ends and close the gap.
        if (d >= 0) this.plot(Math.round(x0 + ux * d), Math.round(y0 + uy * d), value);
        continue;
      }
      // A dash can start on the previous segment; draw only the part on this one.
      const s = Math.max(0, d);
      const e = Math.min(length, d + on - 1);
      if (e >= s) this.line(x0 + ux * s, y0 + uy * s, x0 + ux * e, y0 + uy * e, value);
    }
    return (phase + length) % period;
  }

  /**
   * A polyline, solid or stippled. Stippling (`[on, off]` pixels) makes a line
   * read dimmer through coverage, which holds up better than grey levels on a
   * display that lifts its darker greys.
   */
  polyline(points: [number, number][], value: number, pattern: boolean | [number, number] = false): void {
    const [on, off] = pattern === true ? [2, 2] : pattern === false ? [0, 0] : pattern;
    let phase = 0;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const q = points[i];
      if (!p || !q) continue;
      if (off > 0) phase = this.dashed(p[0], p[1], q[0], q[1], value, on, off, phase);
      else this.line(p[0], p[1], q[0], q[1], value);
    }
  }

  circle(cx: number, cy: number, r: number, value: number, segments = Math.max(12, Math.round(r * 3))): void {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      this.line(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(b) * r, cy + Math.sin(b) * r, value);
    }
  }

  disc(cx: number, cy: number, r: number, value: number): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r + 0.5) this.plot(x, y, value * Math.min(1, r - d + 0.5));
      }
    }
  }

  /** Clears a disc to black: a "knockout" halo so a marker stands clear of the map under it. */
  clear(cx: number, cy: number, r: number): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x >= 0 && y >= 0 && x < this.width && y < this.height && Math.hypot(x - cx, y - cy) <= r) this.pixels[y * this.width + x] = 0;
      }
    }
  }

  /** Fills closed rings (even-odd) with a texture, scanline by scanline. */
  fill(rings: [number, number][][], value: number, texture: Texture = "solid", density = 0.5): void {
    const edges: [number, number, number, number][] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        if (p && q && p[1] !== q[1]) edges.push([p[0], p[1], q[0], q[1]]);
      }
    }
    const threshold = density * 16;
    for (let y = 0; y < this.height; y++) {
      const sy = y + 0.5;
      const xs: number[] = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) xs.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k] ?? 0) - 0.5));
        const to = Math.min(this.width - 1, Math.floor((xs[k + 1] ?? 0) - 0.5));
        for (let x = from; x <= to; x++) {
          if (texture === "solid") this.plot(x, y, value);
          else if (texture === "dither") {
            if ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) < threshold) this.plot(x, y, value);
          } else if (texture === "dots") {
            if (x % 4 === 0 && y % 4 === (x % 8 === 0 ? 0 : 2)) this.plot(x, y, value);
          } else if ((x + y) % 5 === 0) this.plot(x, y, value); // hatch
        }
      }
    }
  }

  /** Text in the 5 x 7 pixel font. Returns the width drawn. */
  text(x: number, y: number, text: string, value: number, scale = 1): number {
    let cx = Math.round(x);
    for (const char of text.toUpperCase()) {
      const glyph = GLYPHS[char] ?? GLYPHS["?"];
      if (glyph) {
        for (let row = 0; row < GLYPH_H; row++) {
          for (let col = 0; col < GLYPH_W; col++) {
            if (glyph[row]?.[col] !== "1") continue;
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++) this.plot(cx + col * scale + sx, Math.round(y) + row * scale + sy, value);
          }
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
    return cx - Math.round(x);
  }

  /** Width the text would take, in pixels. */
  static textWidth(text: string, scale = 1): number {
    return text.length * (GLYPH_W + 1) * scale - scale;
  }
}

export function sameFrame(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
