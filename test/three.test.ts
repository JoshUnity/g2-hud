import { describe, expect, it } from "vitest";
import { Canvas } from "../src/core/pixels";
import { drawGraph, layoutGraph, project, rotate, type Graph3, type Vec3 } from "../src/core/three";

/** A ring of 10 hubs, each with 3 leaves: 40 nodes. */
function sample(): [number, [number, number][]] {
  const links: [number, number][] = [];
  for (let h = 0; h < 10; h++) {
    links.push([h, (h + 1) % 10]);
    for (let l = 0; l < 3; l++) links.push([h, 10 + h * 3 + l]);
  }
  return [40, links];
}

describe("rotate and project", () => {
  it("rotates like the mock: a quarter yaw turns +x into -z", () => {
    const [x, y, z] = rotate([1, 0, 0], Math.PI / 2, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });
  it("keeps length", () => {
    const v: Vec3 = [0.3, -0.5, 0.7];
    const r = rotate(v, 1.1, 0.4);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(...v));
  });
  it("projects with k = 3.4 / (3.4 + z), y up", () => {
    const p = project([1, 1, 0], 100, 50, 10);
    expect(p).toEqual({ x: 110, y: 40, z: 0 });
    expect(project([1, 0, 3.4], 0, 0, 10).x).toBeCloseTo(5);
  });
});

describe("layoutGraph", () => {
  const [n, links] = sample();
  it("is deterministic", () => {
    expect(layoutGraph(n, links)).toEqual(layoutGraph(n, links));
    expect(layoutGraph(n, links, 3)).not.toEqual(layoutGraph(n, links, 4));
  });
  it("keeps every point inside the unit ball", () => {
    for (const p of layoutGraph(n, links)) expect(Math.hypot(...p)).toBeLessThanOrEqual(1);
  });
  it("puts linked pairs closer than unlinked pairs", () => {
    const pts = layoutGraph(n, links);
    const key = new Set(links.flatMap(([a, b]) => [`${a}-${b}`, `${b}-${a}`]));
    const dist = (i: number, j: number) => Math.hypot(...(pts[i] as Vec3).map((v, k) => v - (pts[j] as Vec3)[k]!));
    let linked = 0, nl = 0, other = 0, no = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (key.has(`${i}-${j}`)) { linked += dist(i, j); nl++; } else { other += dist(i, j); no++; }
      }
    expect(linked / nl).toBeLessThan((other / no) * 0.7);
  });
  it("handles 0, 1 and 80 nodes quickly", () => {
    expect(layoutGraph(0, [])).toEqual([]);
    expect(layoutGraph(1, [])).toEqual([[0, 0, 0]]);
    const t = Date.now();
    const big = layoutGraph(80, Array.from({ length: 160 }, (_, i) => [i % 80, (i * 7 + 3) % 80] as [number, number]));
    expect(big).toHaveLength(80);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("drawGraph", () => {
  const view = { cx: 144, cy: 72, scale: 60, yaw: 0.5, pitch: 0.3 };
  const [n, links] = sample();
  const graph: Graph3 = { points: layoutGraph(n, links), links };

  it("returns one point per node and writes only the named values", () => {
    const c = new Canvas(288, 144);
    const pts = drawGraph(c, graph, view, { lit: [1, 2, 3], focus: 0, labels: { 4: "ATLAS" } });
    expect(pts).toHaveLength(n);
    const values = new Set(c.pixels);
    values.delete(0);
    for (const v of values) expect([255, 119, 85, 51, 204, 136, 221]).toContain(v);
    expect(values.has(255)).toBe(true);
    expect(values.has(221)).toBe(true);
  });

  it("draws a far node dimmer than a near one", () => {
    const g: Graph3 = { points: [[0, 0, -0.9], [0, 0, 0.9]], links: [] };
    const near = new Canvas(100, 100);
    const far = new Canvas(100, 100);
    drawGraph(near, { points: [g.points[0]!], links: [] }, { cx: 50, cy: 50, scale: 30, yaw: 0, pitch: 0 });
    drawGraph(far, { points: [g.points[1]!], links: [] }, { cx: 50, cy: 50, scale: 30, yaw: 0, pitch: 0 });
    expect(Math.max(...near.pixels)).toBe(204);
    expect(Math.max(...far.pixels)).toBe(119);
    expect([...near.pixels].filter((v) => v > 0).length).toBe(9);
    expect([...far.pixels].filter((v) => v > 0).length).toBe(1);
  });

  it("draws a link between lit nodes solid at 255, and a far link dotted at 51", () => {
    const view0 = { cx: 50, cy: 50, scale: 30, yaw: 0, pitch: 0 };
    const lit = new Canvas(100, 100);
    drawGraph(lit, { points: [[-0.8, 0, 0], [0.8, 0, 0]], links: [[0, 1]] }, view0, { lit: [0, 1] });
    expect(lit.pixels[50 * 100 + 50]).toBe(255);
    const far = new Canvas(100, 100);
    drawGraph(far, { points: [[-0.8, 0, 0.9], [0.8, 0, 0.9]], links: [[0, 1]] }, view0);
    const row = [...far.pixels.slice(50 * 100, 51 * 100)];
    expect(new Set(row.filter((v) => v > 0))).toEqual(new Set([51, 119])); // the dotted link and the two far nodes
    expect(row.filter((v) => v === 51).length).toBeGreaterThan(5);
    expect(row.filter((v) => v === 51).length).toBeLessThan(row.filter((v) => v === 0).length);
  });
});
