import type { Box } from "../core/box";
import type { Producer } from "../core/imagepipe";
import { Canvas } from "../core/pixels";

/**
 * The Code mark: a terminal prompt, a chevron and a cursor block, drawn in code
 * at 64 x 64. The cursor carries the state. It rests while idle, rises with your
 * voice while you talk, slides while the agent works, turns hollow and pulses with
 * the whole mark when it needs your approval, rises into place when done, and
 * breaks apart, dim, on an error.
 */
export type MarkMode = "off" | "idle" | "recording" | "working" | "approval" | "done" | "error";

/** A thick stroke from anti-aliased lines, stacked along the minor axis, with round caps. */
function stroke(canvas: Canvas, x0: number, y0: number, x1: number, y1: number, width: number, value: number): void {
  const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  const half = Math.floor(width / 2);
  for (let k = -half; k <= half; k++) {
    if (steep) canvas.line(x0 + k, y0, x1 + k, y1, value);
    else canvas.line(x0, y0 + k, x1, y1 + k, value);
  }
  canvas.disc(x0, y0, width / 2 - 0.5, value);
  canvas.disc(x1, y1, width / 2 - 0.5, value);
}

/** A filled rectangle whose edges may fall between pixels; partly covered pixels get partial light. */
function block(canvas: Canvas, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const cy = Math.min(y + 1, y1) - Math.max(y, y0);
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.min(x + 1, x1) - Math.max(x, x0);
      if (cx > 0 && cy > 0) canvas.plot(x, y, value * cx * cy);
    }
  }
}

export function renderMark(mode: MarkMode, t: number, since: number, level: number, size = 64): Uint8Array {
  const canvas = new Canvas(size, size);
  const u = size / 64; // the mark is laid out on a 64 x 64 grid
  const dim = mode === "off" || mode === "error";
  // Approval: the whole mark pulses once a second.
  const pulse = mode === "approval" ? (140 + 115 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2))) / 255 : 1;
  const prompt = (dim ? 120 : 210) * pulse;
  const cursor = (dim ? 120 : 255) * pulse;
  // Done: the cursor rises into place and the chevron steps in, then both rest.
  const rise = mode === "done" && since < 0.8 ? 0.35 + 0.65 * Math.sin((since / 0.8) * (Math.PI / 2)) : 1;
  const shift = (1 - rise) * -9 * u;

  // The chevron ">", pointing at the cursor. On an error its upper arm is broken.
  const width = Math.max(1, Math.round(5 * u));
  const [ax, ay, bx, by, cx, cy] = [15 * u + shift, 15 * u, 32 * u + shift, 32 * u, 15 * u + shift, 49 * u];
  if (mode === "error") {
    stroke(canvas, ax, ay, ax + (bx - ax) * 0.35, ay + (by - ay) * 0.35, width, prompt);
    stroke(canvas, ax + (bx - ax) * 0.6, ay + (by - ay) * 0.6, bx, by, width, prompt);
  } else stroke(canvas, ax, ay, bx, by, width, prompt);
  stroke(canvas, bx, by, cx, cy, width, prompt);

  // The cursor: a block from x 38 to 51, y 20 to 46 at rest.
  const [left, right, top, bottom] = [38 * u, 51 * u, 20 * u, 46 * u];
  if (mode === "recording") {
    // An underscore that rises toward a full block with your voice.
    const reach = Math.min(0.85, level * 1.6 + 0.12 * (0.5 + 0.5 * Math.sin(t * 7)));
    block(canvas, left, bottom - (4 + 22 * reach) * u, right, bottom, cursor);
  } else if (mode === "working") {
    // A narrow bar slides to and fro across the cursor cell, with a fading trail.
    const bar = 4 * u;
    const at = (s: number) => left + (right - left - bar) * (0.5 - 0.5 * Math.cos(s * Math.PI * 1.2));
    block(canvas, at(t - 0.16), top, at(t - 0.16) + bar, bottom, cursor * 0.25);
    block(canvas, at(t - 0.08), top, at(t - 0.08) + bar, bottom, cursor * 0.5);
    block(canvas, at(t), top, at(t) + bar, bottom, cursor);
  } else if (mode === "approval") {
    // A hollow cursor: the prompt waits for you.
    const edge = 2 * u;
    block(canvas, left, top, right, top + edge, cursor);
    block(canvas, left, bottom - edge, right, bottom, cursor);
    block(canvas, left, top, left + edge, bottom, cursor);
    block(canvas, right - edge, top, right, bottom, cursor);
  } else if (mode === "error") {
    // The cursor breaks into three slices, knocked out of line.
    const third = (bottom - top - 4 * u) / 3;
    [-3, 2, -1].forEach((dx, i) => {
      const y = top + i * (third + 2 * u);
      block(canvas, left + dx * u, y, right + dx * u, y + third, cursor);
    });
  } else block(canvas, left + shift, bottom - (bottom - top) * rise, right + shift, bottom, cursor);
  return canvas.pixels;
}

export function markFps(mode: MarkMode, since: number, level: number): number {
  if (mode === "working") return 8;
  if (mode === "recording") return level > 0.05 ? 8 : 4;
  if (mode === "approval") return 4;
  if (mode === "done") return since < 1 ? 8 : 0;
  return 0;
}

export class CodeMark {
  private mode: MarkMode = "idle";
  private modeAt = performance.now();
  private level = 0;
  private target = 0;

  constructor(private box: Box) {}

  setMode(mode: MarkMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeAt = performance.now();
  }

  setLevel(level: number): void {
    this.target = Math.max(this.target, Math.max(0, Math.min(1, level)));
  }

  producer(): Producer {
    return {
      box: this.box,
      fps: () => markFps(this.mode, (performance.now() - this.modeAt) / 1000, this.level),
      render: (t) => {
        this.level += (this.target - this.level) * 0.35;
        this.target *= 0.8;
        return renderMark(this.mode, t, (performance.now() - this.modeAt) / 1000, this.level, this.box.width);
      },
    };
  }
}
