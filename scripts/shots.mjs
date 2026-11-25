// Makes the README screenshots: docs/<name>.png, one per row of SHOTS.
// Run as: npm run shots            (all shots)
//         npm run shots -- sky code (only these)
// It needs the Vite dev server on http://localhost:5173 (npm run dev:web).
// For each shot it starts the simulator on the demo URL, waits until the page has settled, saves the
// 576 x 288 lens picture, and writes it on solid black with 16 px of black padding (608 x 320).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://localhost:5173";
const PORT = 9920;
const API = `http://127.0.0.1:${PORT}`;
const SIMULATOR = resolve(ROOT, "node_modules/@evenrealities/evenhub-simulator/bin/index.js");
const SETTLE_MS = 2500;
const START_TIMEOUT_MS = 30_000;
const PAD = 16;

/** name: the file in docs/. app: the app folder. query: the page URL query string. */
const SHOTS = [
  { name: "answers", app: "answers", query: "demo=answer&intro=0&load=off" },
  { name: "answers-recall", app: "answers", query: "demo=recall&intro=0&load=off" },
  { name: "answers-sources", app: "answers", query: "demo=sources&intro=0&load=off" },
  { name: "code", app: "code", query: "demo=working&intro=0&load=off" },
  { name: "code-approval", app: "code", query: "demo=approval&intro=0&load=off" },
  { name: "hackos", app: "hackos", query: "demo=waking&intro=0&load=off" },
  { name: "around", app: "around", query: "demo=1&intro=0&load=off" },
  { name: "sky", app: "sky", query: "demo=1&intro=0&load=off" },
  { name: "intro", app: "answers", query: "demo=idle&intro=1000" },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- PNG ----------------------------------------------------------------------------

/** Decodes an 8-bit, non-interlaced PNG (RGBA, or RGB) to { width, height, rgba }. */
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("The screenshot is not a PNG.");
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  for (let at = 8; at + 8 <= buffer.length; ) {
    const size = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + size);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) throw new Error(`Unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace}).`);
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") parts.push(data);
    else if (type === "IEND") break;
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`);
      out[y * stride + x] = (raw[src + x] + add) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < channels; c++) rgba[i * 4 + c] = out[i * channels + c];
  return { width, height, rgba };
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes opaque RGB (8-bit, filter 0 on every row). */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The lens picture on solid black, with PAD px of black on every side. */
function onBlack({ width, height, rgba }) {
  const [w, h] = [width + 2 * PAD, height + 2 * PAD];
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = ((y + PAD) * w + x + PAD) * 3;
      const alpha = rgba[from + 3] / 255;
      for (let c = 0; c < 3; c++) rgb[to + c] = Math.round(rgba[from + c] * alpha);
    }
  }
  return encodePng(w, h, rgb);
}

// ---- Simulator ----------------------------------------------------------------------

async function waitForPong() {
  const end = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      const reply = await fetch(`${API}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if ((await reply.text()).trim() === "pong") return;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error(`The simulator did not answer on port ${PORT} within ${START_TIMEOUT_MS / 1000} s.`);
}

function stop(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Starts the simulator, takes one lens screenshot, and always stops that simulator. */
async function capture(url) {
  const child = spawn("node", [SIMULATOR, url, "--automation-port", String(PORT), "--no-glow"], { cwd: ROOT, stdio: "ignore", detached: true });
  const stopped = new Promise((done) => child.once("exit", done));
  try {
    await waitForPong();
    await sleep(SETTLE_MS);
    const reply = await fetch(`${API}/api/screenshot/glasses`);
    if (!reply.ok) throw new Error(`The screenshot call failed: HTTP ${reply.status}.`);
    return Buffer.from(await reply.arrayBuffer());
  } finally {
    // The wrapper starts a native binary, so stop the whole process group, never a process by name.
    stop(child, "SIGTERM");
    await Promise.race([stopped, sleep(3000)]);
    stop(child, "SIGKILL");
  }
}

// ---- Main ---------------------------------------------------------------------------

async function main() {
  try {
    await fetch(`${ORIGIN}/apps/answers/`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error(`The Vite dev server is not running on ${ORIGIN}. Start it with "npm run dev:web", then run this again.`);
    process.exit(1);
  }
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown shot: ${unknown.join(", ")}. Known: ${SHOTS.map((shot) => shot.name).join(", ")}.`);
    process.exit(1);
  }
  const docs = resolve(ROOT, "docs");
  mkdirSync(docs, { recursive: true });
  for (const shot of SHOTS.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
    const url = `${ORIGIN}/apps/${shot.app}/?${shot.query}`;
    process.stdout.write(`${shot.name}  ${url}\n`);
    const png = onBlack(decodePng(await capture(url)));
    writeFileSync(resolve(docs, `${shot.name}.png`), png);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
