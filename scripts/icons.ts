// Builds the Even Hub listing icons.
// Run as: npx tsx scripts/icons.ts [app ...]   (npm run icons)
// The source of truth is src/<app>/icon.ts: a 12 x 12 grid where "#" is lit.
// Each cell is a 2 x 2 block of the 24 x 24 icon, which is what the portal
// wants (see "Icon rules" in the evenhub-cli README).
// The script writes apps/<app>/icon.png for every app.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { ICON_CELLS, checkIconGrid, type IconGrid } from "../src/core/icon";

export const ICON_SIZE = ICON_CELLS * 2;
export const LIT = [0xf4, 0xf4, 0xf4, 0xff] as const;
const MAX_PNG_BYTES = 1024 * 1024;
export const ICON_APPS = ["answers", "around", "sky", "code", "hackos"] as const;

/** The 24 x 24 RGBA pixels: each lit cell is an opaque #F4F4F4 block, the rest is transparent. A dim cell (`+`) is an error. */
export function buildPixels(grid: IconGrid): Uint8Array {
  checkIconGrid(grid);
  const rgba = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  grid.forEach((row, cy) =>
    [...row].forEach((char, cx) => {
      if (char === "+") throw new Error(`icon row ${cy + 1}, column ${cx + 1}: a store icon has no dim cells; use "#" or ".".`);
      if (char !== "#") return;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) rgba.set(LIT, ((cy * 2 + dy) * ICON_SIZE + cx * 2 + dx) * 4);
    }),
  );
  return rgba;
}

/**
 * The portal rules on RGBA data. Returns a list of problems, empty when the icon is valid.
 * 1 PNG at most 1 MB (checked only when `pngBytes` is given), 2 exactly 24 x 24,
 * 3 every pixel transparent or opaque #F4F4F4, 4 lit pixels form raster-aligned 2 x 2 blocks.
 */
export function checkIconPixels(rgba: Uint8Array, width = ICON_SIZE, height = ICON_SIZE, pngBytes?: number): string[] {
  const problems: string[] = [];
  if (pngBytes !== undefined && pngBytes > MAX_PNG_BYTES) problems.push(`PNG is ${pngBytes} bytes; the limit is ${MAX_PNG_BYTES}.`);
  if (width !== ICON_SIZE || height !== ICON_SIZE) return [...problems, `icon is ${width}x${height}; it must be ${ICON_SIZE}x${ICON_SIZE}.`];
  const at = (x: number, y: number): Uint8Array => rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
  const lit = (x: number, y: number): boolean => at(x, y)[3] !== 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      if (a === 0) continue;
      if (a !== 255 || r !== 0xf4 || g !== 0xf4 || b !== 0xf4) problems.push(`pixel (${x}, ${y}) is rgba(${r}, ${g}, ${b}, ${a}); use transparent or opaque #F4F4F4.`);
    }
  }
  if (problems.length > 0) return problems;
  const used = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!lit(x, y) || used.has(y * width + x)) continue;
      const block = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] as const;
      if (block.some(([bx, by]) => bx >= width || by >= height || !lit(bx, by) || used.has(by * width + bx))) {
        problems.push(`lit pixel (${x}, ${y}) does not start a 2x2 block.`);
        continue;
      }
      for (const [bx, by] of block) used.add(by * width + bx);
    }
  }
  return problems;
}

/** An 8-bit RGBA PNG. */
export function encodePng(rgba: Uint8Array, width = ICON_SIZE, height = ICON_SIZE): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The PNG for an app's icon, checked against the portal rules. */
export function buildPng(grid: IconGrid): Buffer {
  const rgba = buildPixels(grid);
  const png = encodePng(rgba);
  const problems = checkIconPixels(rgba, ICON_SIZE, ICON_SIZE, png.length);
  if (problems.length > 0) throw new Error(problems.join(" "));
  return png;
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const asked = process.argv.slice(2);
  const apps = asked.length > 0 ? asked : ICON_APPS;
  let failed = false;
  for (const app of apps) {
    try {
      const { ICON } = (await import(pathToFileURL(join(root, "src", app, "icon.ts")).href)) as { ICON: IconGrid };
      writeFileSync(join(root, "apps", app, "icon.png"), buildPng(ICON));
      console.log(`apps/${app}/icon.png`);
    } catch (error) {
      failed = true;
      console.error(`${app}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
