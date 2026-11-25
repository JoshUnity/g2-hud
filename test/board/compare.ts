import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import type { BoardText } from "./reference";

/**
 * Comparing the build with the board. The board's frames hold grey levels 0-15. The build's rasters hold values
 * 0-255 (17 apart): they are compared by level, `Math.round(value / 17)`.
 */

export type Diff = {
  different: number;
  first: { x: number; y: number; build: number; board: number } | null;
  /** The box that holds every different pixel. */
  bounds: { x: number; y: number; width: number; height: number } | null;
};
export type CompareOptions = {
  /** The build already holds levels 0-15, not 0-255. */
  buildLevels?: boolean;
  /** Row width of both rasters. Default 576. */
  width?: number;
};

const level = (value: number, levels: boolean): number => (levels ? value : Math.round(value / 17));

/** Counts the pixels where the build's level differs from the board's, and reports the first one in reading order. */
export function diffFrames(build: Uint8Array, board: Uint8Array, options: CompareOptions = {}): Diff {
  const width = options.width ?? 576;
  const levels = options.buildLevels ?? false;
  if (build.length !== board.length) throw new Error(`The build has ${build.length} pixels, the board ${board.length}.`);
  let different = 0;
  let first: Diff["first"] = null;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < board.length; i++) {
    const have = level(build[i] ?? 0, levels);
    const want = board[i] ?? 0;
    if (have === want) continue;
    different++;
    const x = i % width;
    const y = Math.floor(i / width);
    first ??= { x, y, build: have, board: want };
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { different, first, bounds: different ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null };
}

/** The part of a raster inside a box, row by row. */
export function crop(pixels: Uint8Array, width: number, box: { x: number; y: number; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y++) out.set(pixels.subarray((box.y + y) * width + box.x, (box.y + y) * width + box.x + box.width), y * box.width);
  return out;
}

/** The lens of an app agent's text, as the glasses would show it: a text container's box position, content and light. */
export type BuildText = { text: string; x: number; y: number; level: number };

export type TextDiff = { missing: BoardText[]; extra: BuildText[] };

const key = (t: { text: string; x: number; y: number; level: number }): string => `${t.level}|${t.x}|${t.y}|${t.text}`;

/**
 * Compares the build's glasses text with the board's: same words, same place (x and the line top y), same light.
 * `missing` is on the board only, `extra` in the build only. Both empty means the text matches.
 */
export function diffTexts(build: readonly BuildText[], board: readonly BoardText[]): TextDiff {
  const have = new Map<string, BuildText[]>();
  for (const t of build) have.set(key(t), [...(have.get(key(t)) ?? []), t]);
  const missing: BoardText[] = [];
  for (const t of board) {
    const list = have.get(key(t));
    if (list && list.length > 0) list.pop();
    else missing.push(t);
  }
  const extra = [...have.values()].flat();
  return { missing, extra };
}

function png(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Writes three panels side by side as a PNG: the board, the build, and the difference (the board dimmed, a pixel
 * only the board lights in green, one only the build lights in red, one both light at another level in yellow).
 * Look at it when a comparison fails. Returns the path.
 */
export function writeDiffPng(path: string, build: Uint8Array, board: Uint8Array, options: CompareOptions = {}): string {
  const width = options.width ?? 576;
  const levels = options.buildLevels ?? false;
  const height = board.length / width;
  const out = new Uint8Array(width * 3 * height * 3);
  const set = (panel: number, i: number, r: number, g: number, b: number): void => {
    const o = (Math.floor(i / width) * width * 3 + panel * width + (i % width)) * 3;
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  };
  for (let i = 0; i < board.length; i++) {
    const want = board[i] ?? 0;
    const have = level(build[i] ?? 0, levels);
    const grey = (l: number): [number, number, number] => [Math.round((60 * l) / 15), Math.round((250 * l) / 15), Math.round((68 * l) / 15)];
    set(0, i, ...grey(want));
    set(1, i, ...grey(have));
    if (have === want) set(2, i, ...grey(Math.round(want * 0.35)));
    else if (have === 0) set(2, i, 0, 255, 0);
    else if (want === 0) set(2, i, 255, 0, 0);
    else set(2, i, 255, 220, 0);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(out, width * 3, height));
  return path;
}
