// A contact sheet of frames, so a PNG shows what the lens would show.
// Run as: npx tsx scripts/frames.ts <app> <out.png>
// Or:     npx tsx scripts/frames.ts kit <out.png>  (the v2 kit: a 3D graph at four angles, and the three type voices)
// It renders the intro of src/<app>/icon.ts (its ICON and ORDER) at 0, 100, ... 1500 ms,
// with the name text that the glasses show under the mark at that time.
// writeSheet() takes any frames, for a scratch script that draws a mark in each state.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { Canvas } from "../src/core/pixels";
import { drawGraph, layoutGraph, type Graph3 } from "../src/core/three";
import type { IconGrid, IconOrder } from "../src/core/icon";
import { renderSplash, splashName, SPLASH_MARK, type SplashSpec } from "../src/core/splash";

/** The name each app shows in its intro. */
const NAMES: Record<string, string> = { answers: "Answers", around: "Around", sky: "Sky", code: "Code", hackos: "HackOS" };

export type Tile = { label: string; pixels: Uint8Array; width: number; height: number };

const GREEN = [0x3d, 0xff, 0x6a] as const;
const GUTTER = 8;
const LABEL_H = 7 + 4;

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG. */
function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The glasses show 16 grey levels, so the sheet does too. */
const quantise = (v: number): number => Math.round(v / 17) * 17;

/** Writes the tiles as one PNG: phosphor green on black, each tile scaled up, its label under it. */
export function writeSheet(tiles: Tile[], outPath: string, options: { columns?: number; scale?: number } = {}): void {
  const columns = Math.max(1, options.columns ?? 4);
  const scale = Math.max(1, options.scale ?? 2);
  const cellW = Math.max(...tiles.map((t) => t.width)) * scale;
  const cellH = Math.max(...tiles.map((t) => t.height)) * scale + LABEL_H;
  const rows = Math.ceil(tiles.length / columns);
  const width = GUTTER + columns * (cellW + GUTTER);
  const height = GUTTER + rows * (cellH + GUTTER);
  const sheet = new Canvas(width, height);
  const labels = new Canvas(width, height);
  tiles.forEach((tile, i) => {
    const x0 = GUTTER + (i % columns) * (cellW + GUTTER);
    const y0 = GUTTER + Math.floor(i / columns) * (cellH + GUTTER);
    for (let y = 0; y < tile.height * scale; y++) {
      for (let x = 0; x < tile.width * scale; x++) {
        const v = tile.pixels[Math.floor(y / scale) * tile.width + Math.floor(x / scale)] ?? 0;
        sheet.plot(x0 + x, y0 + y, quantise(v));
      }
    }
    labels.text(x0, y0 + tile.height * scale + 4, tile.label, 255);
  });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const v = Math.max(sheet.pixels[i] ?? 0, labels.pixels[i] ?? 0) / 255;
    GREEN.forEach((channel, k) => (rgb[i * 3 + k] = Math.round(channel * v)));
  }
  // Tile frames: a dim outline of each lens area, so empty frames are still visible.
  const dim = GREEN.map((c) => Math.round(c * 0.18));
  tiles.forEach((tile, i) => {
    const x0 = GUTTER + (i % columns) * (cellW + GUTTER);
    const y0 = GUTTER + Math.floor(i / columns) * (cellH + GUTTER);
    for (let y = -1; y <= tile.height * scale; y++) {
      for (let x = -1; x <= tile.width * scale; x++) {
        if (x !== -1 && y !== -1 && x !== tile.width * scale && y !== tile.height * scale) continue;
        const px = x0 + x;
        const py = y0 + y;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        dim.forEach((channel, k) => (rgb[(py * width + px) * 3 + k] = channel));
      }
    }
  });
  writeFileSync(outPath, encodePng(rgb, width, height));
}

/** The v2 kit on one sheet: a 40-node graph at four yaw angles, then the three type voices. */
function kitTiles(): Tile[] {
  // A tree (each node hangs off an earlier one) with a few cross links, like a vault.
  const links: [number, number][] = [];
  for (let i = 1; i < 40; i++) {
    links.push([i, Math.floor((i - 1) / 3)]);
    if (i % 4 === 0) links.push([i, (i * 7 + 3) % i]);
  }
  const graph: Graph3 = { points: layoutGraph(40, links), links };
  const near = links.flatMap(([a, b]) => (a === 0 ? [b] : b === 0 ? [a] : [])).slice(0, 3);
  const names = ["PRICING PLAN", "NORTHWIND", "ATLAS MIGRATION"];
  const labels = Object.fromEntries(near.map((n, i) => [n, names[i] ?? ""]));
  const tiles: Tile[] = [0, 0.8, 1.6, 2.4].map((yaw) => {
    const c = new Canvas(288, 144);
    drawGraph(c, graph, { cx: 120, cy: 76, scale: 64, yaw, pitch: 0.36 }, { focus: 0, lit: near, labels });
    return { label: `graph yaw ${yaw}`, pixels: c.pixels, width: 288, height: 144 };
  });
  const t = new Canvas(288, 144);
  t.text(8, 8, "PERSON", 128);
  t.textRight(280, 8, "SEEN 12 NOV", 128);
  t.text(8, 22, "SARAH CHEN", 255, 3, true);
  t.text(8, 52, "ALT FT", 128);
  t.text(8, 63, "1,800", 255, 2);
  t.text(110, 52, "ELAPSED", 128);
  t.text(110, 63, "0:42", 255, 4, true);
  t.text(8, 96, "38", 255, 6, true);
  t.text(90, 124, "SEC", 153);
  t.textCenter(210, 100, "CENTRED", 153);
  tiles.push({ label: "type: micro, value, dots 3 4 6", pixels: t.pixels, width: 288, height: 144 });
  return tiles;
}

async function main(): Promise<void> {
  const [app, out] = process.argv.slice(2);
  if (!app || !out) {
    console.error("Usage: npx tsx scripts/frames.ts <app> <out.png>");
    process.exit(1);
  }
  if (app === "kit") {
    writeSheet(kitTiles(), resolve(out), { columns: 2, scale: 2 });
    console.log(`Wrote ${resolve(out)}`);
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { ICON, ORDER } = (await import(pathToFileURL(resolve(root, "src", app, "icon.ts")).href)) as { ICON?: IconGrid; ORDER?: IconOrder };
  const name = NAMES[app];
  if (!ICON || !ORDER || !name) throw new Error(`src/${app}/icon.ts must export ICON and ORDER, and NAMES in scripts/frames.ts must list "${app}".`);
  const spec: SplashSpec = { name, icon: ICON, order: ORDER };
  const tiles: Tile[] = Array.from({ length: 16 }, (_, i) => {
    const ms = i * 100;
    const text = splashName(spec, ms);
    return {
      label: `${ms}  "${text.content}" c${text.color}`,
      pixels: renderSplash(spec, ms),
      width: SPLASH_MARK.width,
      height: SPLASH_MARK.height,
    };
  });
  writeSheet(tiles, resolve(out), { scale: 3 });
  console.log(`Wrote ${resolve(out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
