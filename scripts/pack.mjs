// Packs the five glasses apps into .ehpk files.
// Run as: node --env-file-if-exists=.env scripts/pack.mjs (npm run pack builds first)
// The tracked apps/<app>/app.json files hold a placeholder network whitelist.
// This script copies each manifest to dist/manifests/<app>.json with the whitelist
// set to HUD_ORIGIN (the Mac server's origin, for example http://<mac-lan-ip>:5173),
// then runs "evenhub pack" on that copy. The tracked manifests are never changed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APPS = ["answers", "around", "sky", "code", "hackos"];

/** Returns HUD_ORIGIN when it is a plain http or https origin; throws a readable error if not. */
export function checkOrigin(value) {
  if (!value) {
    throw new Error("HUD_ORIGIN is not set. Add HUD_ORIGIN=http://<your-mac-lan-ip>:5173 to .env.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`HUD_ORIGIN "${value}" is not a URL. Use a value like http://<your-mac-lan-ip>:5173.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HUD_ORIGIN "${value}" must start with http:// or https://.`);
  }
  if (url.origin !== value) {
    throw new Error(`HUD_ORIGIN "${value}" must be an origin only (scheme, host and port, no path). Use "${url.origin}".`);
  }
  return value;
}

/** Returns a copy of the manifest with every network whitelist set to [origin]. The input is not changed. */
export function stampManifest(manifest, origin) {
  const permissions = manifest.permissions ?? [];
  if (!permissions.some((p) => p.name === "network")) {
    throw new Error(`Manifest ${manifest.package_id ?? "(no package_id)"} has no network permission to stamp.`);
  }
  return {
    ...manifest,
    permissions: permissions.map((p) => (p.name === "network" ? { ...p, whitelist: [origin] } : p)),
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let origin;
  try {
    origin = checkOrigin(process.env.HUD_ORIGIN);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const outDir = join(root, "dist/manifests");
  mkdirSync(outDir, { recursive: true });
  for (const app of APPS) {
    const manifest = JSON.parse(readFileSync(join(root, "apps", app, "app.json"), "utf8"));
    const stamped = join(outDir, `${app}.json`);
    writeFileSync(stamped, `${JSON.stringify(stampManifest(manifest, origin), null, 2)}\n`);
    const result = spawnSync(
      join(root, "node_modules/.bin/evenhub"),
      ["pack", stamped, join(root, "dist", app), "-o", `${app}.ehpk`],
      { stdio: "inherit", cwd: root },
    );
    if (result.error) {
      console.error(`Could not start evenhub: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
