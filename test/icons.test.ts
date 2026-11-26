import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICON_CELLS, IconMark, checkIconGrid, drawIcon, renderIcon, type IconGrid, type IconOrder } from "../src/core/icon";
import { Canvas } from "../src/core/pixels";
import { ICON_APPS, buildPixels, buildPng, checkIconPixels } from "../scripts/icons";

const blankRow = ".".repeat(12);
const blank = (): string[] => Array.from({ length: 12 }, () => blankRow);

describe("checkIconGrid", () => {
  it("accepts a 12 x 12 grid of #, + and .", () => {
    const grid = blank();
    grid[0] = "#+..........";
    expect(() => checkIconGrid(grid)).not.toThrow();
  });
  it("rejects the wrong number of rows", () => {
    expect(() => checkIconGrid(blank().slice(1))).toThrow(/12 rows, found 11/);
  });
  it("rejects a row of the wrong width", () => {
    const grid = blank();
    grid[2] = ".".repeat(11);
    expect(() => checkIconGrid(grid)).toThrow(/row 3 needs 12 characters, found 11/);
  });
  it("rejects a bad character", () => {
    const grid = blank();
    grid[0] = ".x..........";
    expect(() => checkIconGrid(grid)).toThrow(/row 1, column 2/);
  });
});

describe("drawIcon and renderIcon", () => {
  const grid = blank();
  grid[0] = "#+..........";
  it("draws each cell as a (cell - gap) square at pitch cell, lit and dim", () => {
    const canvas = new Canvas(96, 96);
    drawIcon(canvas, grid, 10, 20, 8, 2);
    const at = (x: number, y: number) => canvas.pixels[y * 96 + x];
    expect(at(10, 20)).toBe(255);
    expect(at(15, 25)).toBe(255);
    expect(at(16, 20)).toBe(0); // the gap
    expect(at(18, 20)).toBe(102); // the dim cell, the board's 0.4
    expect(at(10, 28)).toBe(0);
  });
  it("renders a 12 * cell square frame", () => {
    const frame = renderIcon(grid);
    expect(frame).toHaveLength(24 * 24);
    expect(frame[0]).toBe(255);
    expect(frame[1]).toBe(255);
    expect(frame[24 + 1]).toBe(255);
    expect(frame[2]).toBe(102);
    expect(renderIcon(grid, 3, 1)).toHaveLength(36 * 36);
  });
});

describe("IconMark", () => {
  it("renders the frame of its mode at box width / 12 and smooths the level", () => {
    const dot = (hot: boolean): IconGrid => [hot ? "#..........." : "+...........", ...blank().slice(1)];
    const seen: number[] = [];
    const mark = new IconMark<"a" | "b">(
      { id: 5, name: "icon", x: 0, y: 2, width: 24, height: 24 },
      (mode, _t, _since, level) => {
        seen.push(level);
        return dot(mode === "a");
      },
      (mode) => (mode === "a" ? 0 : 8),
      "a",
    );
    const producer = mark.producer();
    expect(producer.fps()).toBe(0);
    expect(producer.render(0)[0]).toBe(255);
    mark.setMode("b");
    expect(producer.fps()).toBe(8);
    expect(producer.render(0)[0]).toBe(102);
    mark.setLevel(1);
    producer.render(0);
    producer.render(0);
    expect(seen.at(-1)).toBeGreaterThan(seen.at(-3) ?? 0);
    expect(seen.at(-1)).toBeLessThan(1);
  });
});

describe("checkIconPixels", () => {
  const blank = () => new Uint8Array(24 * 24 * 4);
  const set = (rgba: Uint8Array, x: number, y: number, v: number[]) => rgba.set(v, (y * 24 + x) * 4);

  it("accepts an empty icon and a full block", () => {
    expect(checkIconPixels(blank())).toEqual([]);
    const rgba = blank();
    for (const [x, y] of [[4, 6], [5, 6], [4, 7], [5, 7]] as const) set(rgba, x, y, [0xf4, 0xf4, 0xf4, 255]);
    expect(checkIconPixels(rgba)).toEqual([]);
  });

  it("rejects a stray single lit pixel", () => {
    const rgba = blank();
    set(rgba, 3, 3, [0xf4, 0xf4, 0xf4, 255]);
    expect(checkIconPixels(rgba)[0]).toMatch(/\(3, 3\)/);
  });

  it("rejects a block that is not raster-aligned (odd offset, three pixels)", () => {
    const rgba = blank();
    for (const [x, y] of [[4, 6], [5, 6], [4, 7]] as const) set(rgba, x, y, [0xf4, 0xf4, 0xf4, 255]);
    expect(checkIconPixels(rgba).length).toBeGreaterThan(0);
  });

  it("rejects an off-colour pixel and a half-transparent pixel", () => {
    const rgba = blank();
    for (const [x, y] of [[4, 6], [5, 6], [4, 7], [5, 7]] as const) set(rgba, x, y, [0xf4, 0xf4, 0xf4, 255]);
    set(rgba, 5, 7, [255, 255, 255, 255]);
    expect(checkIconPixels(rgba)[0]).toMatch(/\(5, 7\).*255, 255, 255/);
    set(rgba, 5, 7, [0xf4, 0xf4, 0xf4, 128]);
    expect(checkIconPixels(rgba)[0]).toMatch(/\(5, 7\)/);
  });

  it("rejects a wrong size and an oversize PNG", () => {
    expect(checkIconPixels(new Uint8Array(32 * 32 * 4), 32, 32)[0]).toMatch(/32x32/);
    expect(checkIconPixels(blank(), 24, 24, 2 * 1024 * 1024)[0]).toMatch(/limit/);
  });
});

describe("app icons", () => {
  it("lists five apps", () => expect(ICON_APPS).toHaveLength(5));

  it.each(ICON_APPS)("%s has a valid icon, a unit-range order and portal-valid pixels", async (app) => {
    const { ICON, ORDER } = (await import(`../src/${app}/icon.ts`)) as { ICON: IconGrid; ORDER: IconOrder };
    expect(() => checkIconGrid(ICON)).not.toThrow();
    expect(ICON.join("")).not.toContain("+");
    const rgba = buildPixels(ICON);
    expect(checkIconPixels(rgba, 24, 24, buildPng(ICON).length), app).toEqual([]);
    let lit = 0;
    for (let row = 0; row < ICON_CELLS; row++) {
      for (let col = 0; col < ICON_CELLS; col++) {
        if (ICON[row]?.[col] !== "#") continue;
        lit++;
        const when = ORDER(row, col);
        expect(when, `${app} (${row}, ${col})`).toBeGreaterThanOrEqual(0);
        expect(when, `${app} (${row}, ${col})`).toBeLessThanOrEqual(1);
      }
    }
    expect(lit).toBeGreaterThan(10);
  });

  it("rejects a dim cell in a store icon", () => {
    const grid = blank();
    grid[0] = "+...........";
    expect(() => buildPixels(grid)).toThrow(/no dim cells/);
  });

  it.each(ICON_APPS)("%s: the committed icon.png is the build of its grid", async (app) => {
    const { ICON } = (await import(`../src/${app}/icon.ts`)) as { ICON: IconGrid };
    const path = new URL(`../apps/${app}/icon.png`, import.meta.url);
    expect(existsSync(path), `${app} icon.png is missing; run npm run icons`).toBe(true);
    const png = buildPng(ICON);
    expect(readFileSync(path).equals(png), `${app} icon.png is stale; run npm run icons`).toBe(true);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(24);
    expect(png.readUInt32BE(20)).toBe(24);
  });
});
