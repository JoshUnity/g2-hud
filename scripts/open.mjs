// Opens a glasses app with the pairing key in its URL.
// Run as: node --env-file-if-exists=.env scripts/open.mjs <sim|qr|url> <app>
//   sim  starts the simulator on http://localhost:5173/apps/<app>/?k=<HUD_TOKEN>
//   qr   prints a QR code for the phone (evenhub qr finds the Mac's LAN address)
//   url  prints the URL to open in a browser on the Mac (HackOS has a Mac page)
// The key comes from HUD_TOKEN at run time; it is never written to a tracked file.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPS = ["answers", "around", "sky", "code", "hackos"];
const MODES = ["sim", "qr", "url"];
const PORT = 5173;
const MIN_TOKEN_LENGTH = 16; // same as server/auth.ts

const [mode, app] = process.argv.slice(2);
if (!MODES.includes(mode) || !APPS.includes(app)) {
  console.error(`Usage: node --env-file-if-exists=.env scripts/open.mjs <${MODES.join("|")}> <${APPS.join("|")}>`);
  process.exit(2);
}
const token = process.env.HUD_TOKEN;
if (!token || token.length < MIN_TOKEN_LENGTH) {
  console.error(
    `HUD_TOKEN is ${token ? "too short" : "not set"}. Create one with "openssl rand -hex 24" ` +
      `and add HUD_TOKEN=<that value> to .env (at least ${MIN_TOKEN_LENGTH} characters).`,
  );
  process.exit(1);
}

const path = `/apps/${app}/?k=${encodeURIComponent(token)}`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs a project tool with the terminal attached and exits with its status. */
function run(file, args) {
  const result = spawnSync(file, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start ${file}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (mode === "url") {
  console.log(`http://localhost:${PORT}${path}`);
} else if (mode === "sim") {
  const simulator = join(root, "node_modules/@evenrealities/evenhub-simulator/bin/index.js");
  run(process.execPath, [simulator, `http://localhost:${PORT}${path}`]);
} else {
  run(join(root, "node_modules/.bin/evenhub"), ["qr", "--port", String(PORT), "--path", path]);
}
