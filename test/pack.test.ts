import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Manifest = { package_id?: string; permissions?: { name: string; whitelist?: string[] }[] };
type PackModule = {
  APPS: string[];
  checkOrigin(value: string | undefined): string;
  stampManifest(manifest: Manifest, origin: string): Manifest;
};

// The script is plain JavaScript without type declarations, so it is imported through a URL.
const packUrl = new URL("../scripts/pack.mjs", import.meta.url).href;
const { APPS, checkOrigin, stampManifest } = (await import(packUrl)) as PackModule;
const read = (app: string): Manifest => JSON.parse(readFileSync(new URL(`../apps/${app}/app.json`, import.meta.url), "utf8"));
const whitelists = (m: Manifest) => (m.permissions ?? []).filter((p) => p.name === "network").map((p) => p.whitelist);

describe("pack manifests", () => {
  it("keeps only the documentation address in the tracked manifests", () => {
    for (const app of APPS) expect(whitelists(read(app))).toEqual([["http://192.0.2.1:5173"]]);
  });

  it("sets every network whitelist to HUD_ORIGIN and leaves the rest alone", () => {
    for (const app of APPS) {
      const manifest = read(app);
      const before = JSON.stringify(manifest);
      const stamped = stampManifest(manifest, "http://10.0.0.5:5173");
      expect(whitelists(stamped)).toEqual([["http://10.0.0.5:5173"]]);
      expect(stamped.permissions?.filter((p) => p.name !== "network")).toEqual(
        manifest.permissions?.filter((p) => p.name !== "network"),
      );
      expect({ ...stamped, permissions: undefined }).toEqual({ ...manifest, permissions: undefined });
      expect(JSON.stringify(manifest)).toBe(before);
    }
  });

  it("refuses a manifest with no network permission", () => {
    expect(() => stampManifest({ package_id: "x", permissions: [] }, "http://10.0.0.5:5173")).toThrow(/no network permission/);
  });

  it("accepts http and https origins", () => {
    expect(checkOrigin("http://10.0.0.5:5173")).toBe("http://10.0.0.5:5173");
    expect(checkOrigin("https://hud.example.com")).toBe("https://hud.example.com");
  });

  it("stops on a missing or malformed HUD_ORIGIN", () => {
    expect(() => checkOrigin(undefined)).toThrow(/HUD_ORIGIN is not set/);
    expect(() => checkOrigin("")).toThrow(/HUD_ORIGIN is not set/);
    expect(() => checkOrigin("10.0.0.5:5173")).toThrow(/not a URL/);
    expect(() => checkOrigin("ftp://10.0.0.5")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => checkOrigin("not a url")).toThrow(/not a URL/);
    expect(() => checkOrigin("ws://10.0.0.5:5173")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => checkOrigin("http://10.0.0.5:5173/apps/answers/")).toThrow(/origin only.*"http:\/\/10\.0\.0\.5:5173"/);
    expect(() => checkOrigin("http://10.0.0.5:5173/")).toThrow(/origin only/);
  });
});
