/**
 * A tiny raster library for the G2's image containers: 8-bit grey in memory,
 * quantised by the glasses to 16 levels. Everything is additive light: the
 * brightest value at a pixel wins, black is the clear lens.
 */
import { GLYPHS, GLYPH_H, GLYPH_W } from "./font5x7";

/** 4 x 4 ordered dither, for textures (water, parks) that read as "material". */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export type Texture = "solid" | "dither" | "dots" | "hatch";

/**
 * The 0-255 value of a board alpha: the board turns an alpha `a` (0 to 1) into one of 16 levels with
 * `Math.round(a * 15)`, and the glasses show 16 levels, each 17 apart. Use it wherever code ports a board value.
 */
export function lv(a: number): number {
  return Math.min(15, Math.max(0, Math.round(a * 15))) * 17;
}

/**
 * Pixel-perfect: lines, circles and discs use whole pixels at one flat value,
 * with no in-between greys, because the glasses lift and smear dark greys.
 */
export class Canvas {
  readonly pixels: Uint8Array;

  /**
   * `over` is the board's rule: the last write wins, so a dim pixel drawn on a bright one replaces it, and a
   * value of 0 draws black. Off (the default) is additive light: the brightest value wins. Use `lensCanvas()`
   * from board.ts for a canvas that draws like the board.
   */
  constructor(
    readonly width: number,
    readonly height: number,
    public over = false,
  ) {
    this.pixels = new Uint8Array(width * height);
  }

  plot(x: number, y: number, value: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    const v = Math.min(255, Math.max(0, Math.round(value)));
    if (this.over || v > (this.pixels[i] ?? 0)) this.pixels[i] = v;
  }

  /**
   * The board's `p(X, Y, a, w, h)`: a w x h block at (X, Y), both rounded. A width or height of 0 (or none)
   * is 1, as in the board. `value` is 0-255: pass `lv(a)`.
   */
  p(x: number, y: number, value: number, w = 1, h = 1): void {
    this.rect(x, y, w || 1, h || 1, value);
  }

  /**
   * Calls `visit` for each pixel of the Bresenham line between two points (rounded to whole pixels), with its
   * step index. Returns the full pixel count. Only the steps near the canvas are visited: the walk jumps to the
   * first one (the state of step k has a closed form), so a far-off end point costs nothing. The pixels and the
   * indexes are those of the full walk, so a dash pattern keeps its phase.
   */
  private walk(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number, i: number) => void): number {
    const ax = Math.round(x0);
    const ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const adx = Math.abs(bx - ax);
    const ady = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    const n = Math.max(adx, ady);
    // The step range whose pixels can be on the canvas, widened by 2 steps for rounding.
    let lo = 0;
    let hi = n;
    const limit = (start: number, dir: number, span: number, size: number): void => {
      // Pixels `start + dir * span * k / n` for k in 0..n, to stay inside [-0.5, size - 0.5].
      if (span === 0) {
        if (start < 0 || start > size - 1) hi = -1;
        return;
      }
      const t0 = (-0.5 - start) / (dir * span);
      const t1 = (size - 0.5 - start) / (dir * span);
      lo = Math.max(lo, Math.floor(Math.min(t0, t1) * n) - 2);
      hi = Math.min(hi, Math.ceil(Math.max(t0, t1) * n) + 2);
    };
    limit(ax, sx, adx, this.width);
    limit(ay, sy, ady, this.height);
    lo = Math.max(0, lo);
    hi = Math.min(n, hi);
    if (hi < lo) return n + 1;
    const major = adx >= ady;
    const big = major ? adx : ady;
    const small = major ? ady : adx;
    if (big === 0) {
      visit(ax, ay, 0);
      return 1;
    }
    // Step k: the major coordinate moved k, the minor one floor((2 * small * k + big) / (2 * big)) (the midpoint rule).
    const minorAt = (k: number): number => Math.floor((2 * small * k + big) / (2 * big));
    for (let k = lo; k <= hi; k++) {
      const m = minorAt(k);
      if (major) visit(ax + sx * k, ay + sy * m, k);
      else visit(ax + sx * m, ay + sy * k, k);
    }
    return n + 1;
  }

  /** A horizontal run of whole pixels, both ends included. */
  private span(x0: number, x1: number, y: number, value: number): void {
    for (let x = x0; x <= x1; x++) this.plot(x, y, value);
  }

  /** Filled rectangle of whole pixels. */
  rect(x: number, y: number, w: number, h: number, value: number): void {
    const left = Math.round(x);
    const top = Math.round(y);
    for (let row = 0; row < Math.round(h); row++) this.span(left, left + Math.round(w) - 1, top + row, value);
  }

  /** A Bresenham line at the flat value. */
  line(x0: number, y0: number, x1: number, y1: number, value: number): void {
    this.walk(x0, y0, x1, y1, (x, y) => this.plot(x, y, value));
  }

  /**
   * A line drawn in dashes: `on` pixels lit, `off` dark, along its length.
   * `phase` is how far into the pattern the line starts; the return value is
   * the phase at its end, so a polyline keeps one pattern across its vertices.
   * The pattern counts whole pixels along the line.
   */
  dashed(x0: number, y0: number, x1: number, y1: number, value: number, on = 2, off = 2, phase = 0): number {
    const period = on + off;
    const count = this.walk(x0, y0, x1, y1, (x, y, i) => {
      if ((phase + i) % period < on) this.plot(x, y, value);
    });
    return (phase + count - 1) % period;
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

  /** Calls `visit(x, y)` for one octant step of the midpoint circle; the caller mirrors it. */
  private midpoint(r: number, visit: (x: number, y: number) => void): void {
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      visit(x, y);
      y++;
      if (err < 0) err += 2 * y + 1;
      else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  /** A midpoint circle: a 1 px ring at the flat value. */
  circle(cx: number, cy: number, r: number, value: number): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    this.midpoint(Math.round(r), (x, y) => {
      for (const [px, py] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]] as const) this.plot(x0 + px, y0 + py, value);
    });
  }

  /** A filled midpoint disc at the flat value. */
  disc(cx: number, cy: number, r: number, value: number): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    this.midpoint(Math.round(r), (x, y) => {
      this.span(x0 - x, x0 + x, y0 + y, value);
      this.span(x0 - x, x0 + x, y0 - y, value);
      this.span(x0 - y, x0 + y, y0 + x, value);
      this.span(x0 - y, x0 + y, y0 - x, value);
    });
  }

  /** The board's `kod`: a knock-out disc, the midpoint disc of `disc` written as black whatever is under it. */
  knockout(cx: number, cy: number, r: number): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const wipe = (from: number, to: number, y: number): void => {
      if (y < 0 || y >= this.height) return;
      for (let x = Math.max(0, from); x <= Math.min(this.width - 1, to); x++) this.pixels[y * this.width + x] = 0;
    };
    this.midpoint(Math.round(r), (x, y) => {
      wipe(x0 - x, x0 + x, y0 + y);
      wipe(x0 - x, x0 + x, y0 - y);
      wipe(x0 - y, x0 + y, y0 + x);
      wipe(x0 - y, x0 + y, y0 - x);
    });
  }

  /** The board's `rr`: a 1 px rounded rectangle outline with corner radius `r`. */
  roundRect(x: number, y: number, w: number, h: number, r: number, value: number): void {
    this.rect(x + r, y, w - 2 * r, 1, value);
    this.rect(x + r, y + h - 1, w - 2 * r, 1, value);
    this.rect(x, y + r, 1, h - 2 * r, value);
    this.rect(x + w - 1, y + r, 1, h - 2 * r, value);
    this.midpoint(r, (u, v) => {
      for (const [a, b] of [[u, v], [v, u]] as const) {
        this.plot(Math.round(x + r - a), Math.round(y + r - b), value);
        this.plot(Math.round(x + w - 1 - r + a), Math.round(y + r - b), value);
        this.plot(Math.round(x + r - a), Math.round(y + h - 1 - r + b), value);
        this.plot(Math.round(x + w - 1 - r + a), Math.round(y + h - 1 - r + b), value);
      }
    });
  }

  /** Clears a rectangle to black. */
  clearRect(x: number, y: number, w: number, h: number): void {
    const left = Math.round(x);
    const top = Math.round(y);
    for (let row = Math.max(0, top); row < Math.min(this.height, top + Math.round(h)); row++)
      for (let col = Math.max(0, left); col < Math.min(this.width, left + Math.round(w)); col++) this.pixels[row * this.width + col] = 0;
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

  /** Copies a grey frame onto the canvas at (x, y), clipped. Additive: the brightest value wins. */
  blit(pixels: Uint8Array, width: number, height: number, x: number, y: number): void {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) this.plot(x + col, y + row, pixels[row * width + col] ?? 0);
    }
  }

  /**
   * Text in the 5 x 7 pixel font. Returns the width drawn.
   * `dots`: each font pixel becomes a (scale - 1) square on a pitch of `scale`,
   * the dot-matrix look. With scale 1 it makes no difference.
   */
  text(x: number, y: number, text: string, value: number, scale = 1, dots = false): number {
    let cx = Math.round(x);
    const size = dots && scale > 1 ? scale - 1 : scale;
    // One step per UTF-16 unit, as the board does, so the advance always equals `textWidth`.
    const upper = text.toUpperCase();
    for (let n = 0; n < upper.length; n++) {
      const glyph = GLYPHS[upper.charAt(n)] ?? GLYPHS["?"];
      if (glyph) {
        for (let row = 0; row < GLYPH_H; row++) {
          for (let col = 0; col < GLYPH_W; col++) {
            if (glyph[row]?.[col] !== "1") continue;
            for (let sy = 0; sy < size; sy++)
              for (let sx = 0; sx < size; sx++) this.plot(cx + col * scale + sx, Math.round(y) + row * scale + sy, value);
          }
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
    return cx - Math.round(x);
  }

  /** Text whose right edge is at `xRight` (the pixel after the last lit column). */
  textRight(xRight: number, y: number, text: string, value: number, scale = 1, dots = false): number {
    return this.text(xRight - Canvas.textWidth(text, scale), y, text, value, scale, dots);
  }

  /** Text centred on `xCenter`. */
  textCenter(xCenter: number, y: number, text: string, value: number, scale = 1, dots = false): number {
    return this.text(xCenter - Canvas.textWidth(text, scale) / 2, y, text, value, scale, dots);
  }

  /** Micro caps for a label: clears a box 2 px around the text first, so it stays legible over a drawing. */
  label(x: number, y: number, text: string, value: number): void {
    this.clearRect(Math.round(x) - 2, Math.round(y) - 2, Canvas.textWidth(text, 1) + 4, GLYPH_H + 4);
    this.text(x, y, text, value);
  }

  /** A 1 px rectangle outline. */
  box(x: number, y: number, w: number, h: number, value: number): void {
    this.rect(x, y, w, 1, value);
    this.rect(x, y + h - 1, w, 1, value);
    this.rect(x, y, 1, h, value);
    this.rect(x + w - 1, y, 1, h, value);
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
