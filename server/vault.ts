import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log";
import { digestBody } from "./notes";
import { buildIndex, fold, type RecallIndex } from "./recall";

/** Settings of vault recall. Folder entries are vault-relative, "" is the vault root. */
export type VaultConfig = {
  root: string;
  folders: string[];
  exclude: string[];
  people: string[];
  meetings: string;
  self: string[];
  cue: boolean;
};
export type NoteKind = "person" | "meeting" | "daily" | "note";
export type VaultNote = {
  path: string;
  title: string;
  kind: NoteKind;
  date: number | null;
  mtimeMs: number;
  aliases: string[];
  people: string[];
  topics: string[];
  links: string[];
  lead: string;
  paras: string[];
  decisions: string[];
  tasks: string[];
};
/** A note marked recall: false. It holds no text, only the names that must never match. */
export type BlockedNote = { blocked: true; path: string; kind: NoteKind; names: string[] };
export type ScanStats = {
  files: number;
  read: number;
  removed: number;
  skipped: number;
  evicted: number;
  ms: number;
  buildMs: number;
  capped: boolean;
};

export const HEAD_BYTES = 65_536,
  MAX_INDEX_NOTES = 20_000,
  RESCAN_MS = 60_000,
  SCAN_WARN_MS = 30_000;

const LEAD_CHARS = 240;
const PARA_CHARS = 240;
const MAX_PARAS = 6;
const ITEM_CHARS = 120;
const MAX_DECISIONS = 5;
const MAX_TASKS = 8;
const DISPLAY_KEYS = ["role", "company", "org", "team", "location"];
const SKIP_NAME = /\.sync-conflict-|conflicted copy|\(recording\)/i;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})-(\d{2}))?/;

/** Path comparison form: APFS keeps names as created (sometimes NFD), and settings are usually NFC. */
const norm = (s: string) => s.normalize("NFC").toLowerCase();

/** Trim, forward slashes, no leading or trailing slash, NFC. */
function cleanEntry(entry: string): string {
  return entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Reads the recall settings. Null (recall off) unless the vault, the folders and the wearer's name are all set. */
export function vaultConfig(env: Record<string, string | undefined> = process.env): VaultConfig | null {
  const raw = env.RECALL_FOLDERS?.trim();
  if (!raw) return null;
  const root = env.OBSIDIAN_VAULT?.trim();
  if (!root) {
    log.warn("vault recall off: RECALL_FOLDERS needs OBSIDIAN_VAULT");
    return null;
  }
  const user = env.HUD_USER_NAME?.trim();
  if (!user) {
    log.warn("vault recall off: RECALL_FOLDERS needs HUD_USER_NAME");
    return null;
  }
  const folders: string[] = [];
  for (const entry of list(raw)) {
    const slashed = entry.replace(/\\/g, "/");
    if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || slashed.startsWith("~")) {
      log.warn("RECALL_FOLDERS entry ignored: absolute path", { entry });
      continue;
    }
    const clean = cleanEntry(slashed);
    if (clean === ".") {
      folders.push("");
      continue;
    }
    if (!clean) continue;
    if (clean.split("/").some((part) => part === ".." || part.startsWith("."))) {
      log.warn("RECALL_FOLDERS entry ignored: hidden or parent folder", { entry });
      continue;
    }
    folders.push(clean);
  }
  if (folders.length === 0) {
    log.warn("vault recall off: no valid RECALL_FOLDERS entry");
    return null;
  }
  const people = list(env.RECALL_PEOPLE ?? "People").map(cleanEntry).filter(Boolean);
  return {
    root,
    folders,
    exclude: excludeEntries(list(env.RECALL_EXCLUDE), root),
    people,
    meetings: cleanEntry(env.MEETINGS_FOLDER ?? "Meetings"),
    self: [fold(user)],
    cue: env.RECALL_CUE?.trim().toLowerCase() !== "off",
  };
}

/** RECALL_EXCLUDE entries in vault-relative form. An entry that can never match is dropped with a warning. */
function excludeEntries(entries: string[], root: string): string[] {
  const rootClean = cleanEntry(root);
  const out: string[] = [];
  for (const entry of entries) {
    let slashed = entry.replace(/\\/g, "/").replace(/^(?:\.\/+)+/, "");
    if (slashed.startsWith("/")) {
      const clean = cleanEntry(slashed);
      if (rootClean && norm(clean).startsWith(norm(rootClean) + "/")) slashed = clean.slice(rootClean.length + 1);
    }
    slashed = slashed.replace(/\/\*{1,2}$/, "");
    const clean = cleanEntry(slashed);
    if (!clean) continue;
    if (/[*?[]/.test(clean) || slashed.startsWith("/") || slashed.startsWith("~") || /^[A-Za-z]:/.test(slashed) || clean.split("/").some((part) => part === ".." || part === ".")) {
      log.warn("RECALL_EXCLUDE entry cannot match", { entry });
      continue;
    }
    out.push(clean);
  }
  return out;
}

/**
 * True when a vault-relative path is inside an excluded folder. An entry with a "/" is a path prefix;
 * an entry without one matches a folder of that name at any depth. NFC and lower case on both sides.
 */
export function excluded(relPath: string, exclude: string[]): boolean {
  const path = norm(cleanEntry(relPath));
  const parts = path.split("/");
  for (const raw of exclude) {
    const entry = norm(cleanEntry(raw));
    if (!entry) continue;
    if (entry.includes("/")) {
      if (path === entry || path.startsWith(entry + "/")) return true;
    } else if (parts.includes(entry)) {
      return true;
    }
  }
  return false;
}

/** One frontmatter item: no quotes, no [[ ]], no |alias part, no leading #. */
function cleanItem(item: string): string {
  let s = item.trim();
  if (/^".*"$|^'.*'$/.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
  const bar = s.indexOf("|");
  if (bar >= 0) s = s.slice(0, bar);
  return s.replace(/^#/, "").trim();
}

function parseValue(value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  if (v.startsWith("[") && v.endsWith("]") && !v.startsWith("[[")) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => cleanItem(String(x))).filter(Boolean);
    } catch {
      // not JSON: a YAML flow list
    }
    return v.slice(1, -1).split(",").map(cleanItem).filter(Boolean);
  }
  if (/^"[^"]*"$|^'[^']*'$/.test(v)) return [cleanItem(v)].filter(Boolean);
  return v.split(",").map(cleanItem).filter(Boolean);
}

/**
 * A shallow frontmatter reader (no YAML dependency). Keys are lower case; every value is a list.
 * front is the raw text of the block, for recallOff.
 * An unclosed block loses its lines up to the first blank line, and the note has no meta; front holds those lines
 * and closed is false.
 */
export function parseFrontmatter(text: string): { meta: Record<string, string[]>; body: string; front: string; closed: boolean } {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = clean.split("\n");
  const meta: Record<string, string[]> = {};
  if (lines[0]?.trim() !== "---") return { meta, body: clean, front: "", closed: true };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) {
    const blank = lines.findIndex((line) => line.trim() === "");
    const front = lines.slice(1, blank < 0 ? lines.length : blank).join("\n");
    return { meta, body: blank < 0 ? "" : lines.slice(blank + 1).join("\n"), front, closed: false };
  }
  for (let i = 1; i < end; i++) {
    const match = /^["']?([A-Za-z_][\w-]*)["']?\s*:\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? "";
    if (value.trim()) {
      meta[key] = parseValue(value);
      continue;
    }
    const items: string[] = [];
    while (i + 1 < end) {
      const item = /^\s*-\s+(.*)$/.exec(lines[i + 1] ?? "");
      if (!item) break;
      const cleaned = cleanItem(item[1] ?? "");
      if (cleaned) items.push(cleaned);
      i++;
    }
    meta[key] = items;
  }
  return { meta, body: lines.slice(end + 1).join("\n"), front: lines.slice(1, end).join("\n"), closed: true };
}

const RECALL_KEY = /^\s*["']?recall["']?\s*:(.*)$/i;

/** A value without a YAML tag such as "!!bool". */
const untag = (s: string) => s.trim().replace(/^!!\w+(?:\s+|$)/, "").trim();

/**
 * True when frontmatter text opts the note out of recall ("recall: false"). The one rule for the index
 * (parseNote) and the past-meeting notes (recentMeetings). It errs towards blocking: any case, quotes,
 * a trailing comment, a flow list, a block list, a quoted or indented key, and any of several recall lines.
 */
export function recallOff(front: string): boolean {
  const lines = front.split(/\r?\n/);
  return lines.some((line, i) => {
    const key = RECALL_KEY.exec(line);
    if (!key) return false;
    let value = untag(key[1] ?? "");
    // An empty value, a comment, an open "[" or a block scalar header: the value is on a later line.
    for (let j = i + 1; (!value || value.startsWith("#") || /^(?:\[|[|>][-+\d]*)$/.test(value)) && j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (!next.trim() || /^\s*#/.test(next)) continue;
      const item = /^\s*-(?:\s+(.*))?$/.exec(next);
      if (item) {
        value = untag(item[1] ?? "");
        continue;
      }
      // A plain scalar on an indented next line ("recall:\n  false") is the value too.
      const cont = /^\s+([^\s#-].*)$/.exec(next);
      if (cont) value = untag(cont[1] ?? "");
      break;
    }
    return /^[[\s"']*false\b/i.test(value);
  });
}

/** Markdown to plain text: link targets, URLs, tags, block ids and emphasis go; "<" and ">" never stay. */
export function flatten(line: string): string {
  return line
    .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias: string | undefined) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp|file|obsidian|mailto):\/?\/?\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/(^|\s)\^[A-Za-z0-9-]+(?=\s|$)/g, "$1")
    .replace(/\*+|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FIELD = /^\s*(?:[-*+]\s+)?([\p{L}\w][\p{L}\w .'’-]{0,30})::?\s/u;
const EMAIL = /\S+@\S+\.\w+/;
const PHONE = /\+?\d(?:[ ().-]{0,2}\d){8,}/;
const SECRET = /\b(pass(word|code|phrase)?|pwd|secret|api[ _-]?key|token|pin|iban|cvv|ssn)\b\s*[:=]|[A-Za-z0-9_\-]{32,}/i;

/** The line filter (best effort): false for field-shaped lines, Dataview fields, emails, phone numbers and secrets. */
export function keepLine(line: string): boolean {
  const field = FIELD.exec(line);
  if (field && !DISPLAY_KEYS.includes((field[1] ?? "").trim().toLowerCase())) return false;
  if (line.includes("::")) return false;
  if (EMAIL.test(line)) return false;
  const noDates = line.replace(/\b\d{4}-\d{2}-\d{2}(?: \d{2}-\d{2})?\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  if (PHONE.test(noDates)) return false;
  if (SECRET.test(line)) return false;
  return true;
}

/** A fresh copy, so a kept extract does not keep the 64 KB head alive. */
const copy = (s: string) => (" " + s).slice(1);

/** Cuts on a word boundary, with "…", to at most max characters. */
function cut(s: string, max: number): string {
  if (s.length <= max) return copy(s);
  const head = s.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return copy((space > max / 2 ? head.slice(0, space) : head).trimEnd() + "…");
}

type Block = { section: string; text: string };
type Body = { paragraphs: Block[]; bullets: Block[]; tasks: string[]; links: string[] };

const TASK = /^\s*[-*+] \[ \] (.+)$/;
const ANY_TASK = /^\s*[-*+] \[.\]/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Leading container markers of a line: any mix of blockquote markers and list markers. */
const PREFIX = /^(?:\s*(?:>|(?:[-*+]|\d+[.)])(?=\s))\s*)*/;
/** A fence opener after the prefix. A backtick fence has no backtick in its info string ("```npm i```" is inline code). */
const FENCE_OPEN = /^\s*(?:(`{3,})(?!.*`)|(~{3,}))/;

/** Display width of s, with tab stops every 4 columns as in CommonMark. */
function width(s: string): number {
  let col = 0;
  for (const ch of s) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** The number of blockquote markers that start a line, before any other text. */
const quoteDepth = (s: string) => (/^(?:\s*>)*/.exec(s)?.[0].match(/>/g) ?? []).length;

/** Length of the first n blockquote markers of s (">" and one optional space each), or -1 when s has fewer. */
function quoteEnd(s: string, n: number): number {
  let at = 0;
  for (let k = 0; k < n; k++) {
    const m = /^\s*>[ \t]?/.exec(s.slice(at));
    if (!m) return -1;
    at += m[0].length;
  }
  return at;
}

/** One pass over the body: paragraphs and bullets by section, open tasks and wikilinks, all filtered. */
function readBody(body: string, kind: NoteKind): Body {
  const paragraphs: Block[] = [];
  const bullets: Block[] = [];
  const tasks: string[] = [];
  const links = new Set<string>();
  let section = "";
  let current: string[] = [];
  const close = () => {
    if (current.length > 0) paragraphs.push({ section, text: current.join(" ") });
    current = [];
  };
  let fence: string | null = null;
  // The opener's container: its quote depth, whether it sat on a list item, and the column where the
  // container's content starts. A line outside that container ends the fence; a closer sits inside it,
  // indented at most 3 more.
  let fenceDepth = 0;
  let fenceList = false;
  let fenceCol = 0;
  let inComment = false;
  let inHtmlComment = false;
  for (const raw of body.split("\n")) {
    if (fence) {
      // CommonMark: a fenced block ends with its container. A line with fewer quote markers (a blank line
      // too), or a non-blank line indented less than the list item's content, ends the fence, and the line
      // is read again as a normal line, because it may open a new fence.
      const at = fenceDepth > 0 && quoteDepth(raw) < fenceDepth ? -1 : quoteEnd(raw, fenceDepth);
      const inner = at < 0 ? "" : raw.slice(at);
      const col = width(raw.slice(0, at) + (/^\s*/.exec(inner)?.[0] ?? ""));
      if (at >= 0 && !(fenceList && inner.trim() && col < fenceCol)) {
        // Close on the same character, at least as long, nothing after it, inside the same container.
        const closer = new RegExp("^\\s*" + fence[0] + "{" + fence.length + ",}\\s*$");
        if (col <= fenceCol + 3 && closer.test(inner)) fence = null;
        continue;
      }
      fence = null;
    }
    // A fence inside a blockquote, a callout or a list item, or after any mix of them, is a fence too.
    const prefix = PREFIX.exec(raw)?.[0] ?? "";
    const fenceOpen = FENCE_OPEN.exec(raw.slice(prefix.length));
    if (fenceOpen && !inComment && !inHtmlComment) {
      fence = fenceOpen[1] ?? fenceOpen[2] ?? null;
      fenceDepth = (prefix.match(/>/g) ?? []).length;
      fenceList = /[^\s>]/.test(prefix);
      // Content column: after the list marker when the prefix ends with one, else after the last quote marker.
      const quoteTail = /^(?:[^>]*>)*[ \t]?/.exec(prefix)?.[0].length ?? 0;
      fenceCol = fenceList && /[^\s>]\s*$/.test(prefix) ? width(prefix) : fenceDepth > 0 ? width(prefix.slice(0, quoteTail)) : 0;
      continue;
    }
    let line = raw;
    // %% comments %% and <!-- comments -->, inline or across lines.
    let out = "";
    let rest = line;
    while (rest) {
      if (inComment) {
        const end = rest.indexOf("%%");
        if (end < 0) { rest = ""; break; }
        inComment = false;
        rest = rest.slice(end + 2);
        continue;
      }
      if (inHtmlComment) {
        const end = rest.indexOf("-->");
        if (end < 0) { rest = ""; break; }
        inHtmlComment = false;
        rest = rest.slice(end + 3);
        continue;
      }
      const pct = rest.indexOf("%%");
      const html = rest.indexOf("<!--");
      if (pct < 0 && html < 0) { out += rest; break; }
      if (html < 0 || (pct >= 0 && pct < html)) {
        out += rest.slice(0, pct);
        inComment = true;
        rest = rest.slice(pct + 2);
      } else {
        out += rest.slice(0, html);
        inHtmlComment = true;
        rest = rest.slice(html + 4);
      }
    }
    const touched = out !== line;
    line = out;
    if (!line.trim()) {
      // A line emptied by a comment is skipped, not blank: it does not split a paragraph.
      if (!touched) close();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      close();
      section = flatten(heading[1] ?? "");
      continue;
    }
    if (/^\s*\|/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*>\s*\[!/.test(line) || line.includes("![[")) continue;
    const task = TASK.exec(line);
    if (task) {
      const text = task[1] ?? "";
      const flat = flatten(text);
      // The filter sees the flattened text too; only an app-written action item keeps its "**Owner:**" prefix.
      const ownerless = kind === "meeting" ? flatten(text.replace(/^\*\*[^*]{1,30}:\*\*\s*/, "")) : flat;
      if (keepLine(text) && keepLine(ownerless) && tasks.length < MAX_TASKS) {
        if (flat) tasks.push(cut(flat, ITEM_CHARS));
        for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) links.add(baseName(m[1] ?? ""));
      }
      continue;
    }
    if (ANY_TASK.test(line)) continue;
    const quoted = line.replace(/^\s*(?:>\s*)+/, "");
    const flat = flatten(quoted);
    if (!keepLine(quoted) || !keepLine(flat) || !flat) continue;
    for (const m of quoted.matchAll(/\[\[([^\]|#]+)/g)) links.add(baseName(m[1] ?? ""));
    if (BULLET.test(quoted)) {
      close();
      const text = flatten(quoted.replace(BULLET, ""));
      if (text) {
        bullets.push({ section, text });
        current.push(text);
      }
      close();
      continue;
    }
    current.push(flat);
  }
  close();
  return { paragraphs, bullets, tasks, links: [...links].filter(Boolean) };
}

function baseName(target: string): string {
  const name = target.trim().split("/").pop() ?? "";
  return name.replace(/\.md$/i, "");
}

/** Local time of a "YYYY-MM-DD[ HH-mm]" stamp, or of a frontmatter date (date-only is local midnight). */
function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const stamp = STAMP.exec(value.trim());
  if (stamp && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return new Date(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])).getTime();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function stampDate(title: string): number | null {
  const m = STAMP.exec(title);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
}

function under(dir: string, entries: string[]): boolean {
  return dir !== "" && excluded(dir, entries);
}

/**
 * Turns one Markdown file into the extracts recall may use. Pure.
 * Null for a draft (status: recording); a BlockedNote for recall: false.
 */
export function parseNote(
  path: string,
  text: string,
  mtimeMs: number,
  config: Pick<VaultConfig, "people" | "meetings">,
): VaultNote | BlockedNote | null {
  const { meta, body, front } = parseFrontmatter(text);
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const title = path.slice(slash + 1).replace(/\.md$/i, "");
  const tags = [...(meta.tags ?? []), ...(meta.tag ?? [])].map((t) => t.toLowerCase());
  const type = (meta.type?.[0] ?? "").toLowerCase();
  const meetingsDir = norm(config.meetings);
  let kind: NoteKind;
  if (tags.includes("meeting") || (meetingsDir !== "" && (norm(dir) === meetingsDir || norm(dir).startsWith(meetingsDir + "/")))) {
    kind = "meeting";
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(title)) {
    kind = "daily";
  } else if (under(dir, config.people) || tags.includes("person") || tags.includes("people") || type === "person") {
    kind = "person";
  } else {
    kind = "note";
  }
  const aliases = [...(meta.aliases ?? []), ...(meta.alias ?? [])].map(copy);
  if (recallOff(front)) {
    const names = [title, ...aliases];
    const first = title.split(/\s+/)[0];
    if (kind === "person" && first && first !== title) names.push(first);
    return { blocked: true, path: copy(path), kind, names: names.map(copy) };
  }
  if ((meta.status?.[0] ?? "").toLowerCase() === "recording") return null;

  const parsed = readBody(kind === "meeting" ? digestBody(body) : body, kind);
  let lead = "";
  let paras: string[] = [];
  let decisions: string[] = [];
  if (kind === "meeting") {
    lead = cut(parsed.paragraphs.filter((p) => /^summary$/i.test(p.section)).map((p) => p.text).join(" "), LEAD_CHARS);
    decisions = parsed.bullets
      .filter((b) => /^decision/i.test(b.section))
      .slice(0, MAX_DECISIONS)
      .map((b) => cut(b.text, ITEM_CHARS));
  } else if (kind !== "daily") {
    const facts = DISPLAY_KEYS.flatMap((key) => meta[key] ?? []).map(flatten).filter((v) => v && keepLine(v));
    const prose = parsed.paragraphs.map((p) => p.text);
    const head = facts.length > 0 ? facts.join(", ") + ". " : "";
    lead = cut((head + (prose[0] ?? "")).trim(), LEAD_CHARS);
    paras = prose.slice(1, 1 + MAX_PARAS).map((p) => cut(p, PARA_CHARS));
  }
  let date: number | null = null;
  if (kind === "meeting" || kind === "daily") {
    date = stampDate(title) ?? parseDate(meta.date?.[0]) ?? parseDate(meta.started?.[0]);
  }
  const people = (meta.people ?? []).map(copy);
  const links = kind === "meeting" ? parsed.links : [...new Set([...parsed.links, ...people])];
  return {
    path: copy(path),
    title: copy(title),
    kind,
    date,
    mtimeMs,
    aliases,
    people,
    topics: (meta.topics ?? []).map(copy),
    links: links.map(copy),
    lead,
    paras,
    decisions,
    tasks: parsed.tasks,
  };
}

type Entry = { mtimeMs: number; size: number; note: VaultNote | BlockedNote | null };
type VaultOptions = { maxNotes?: number; onFile?: (relPath: string) => void | Promise<void> };

const isBlocked = (note: VaultNote | BlockedNote): note is BlockedNote => "blocked" in note;

/**
 * The vault as recall sees it: the listed folders, read on the Mac, with an index rebuilt after each change.
 * No timer and no watcher: the server calls refresh() at quiet moments.
 */
export class Vault {
  private files = new Map<string, Entry>();
  private current: RecallIndex | null = null;
  private lastStats: ScanStats | null = null;
  private scanning: Promise<boolean> | null = null;
  private scanStartedAt = 0;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private rerun = false;
  private warnedSlow = false;
  private rootDown = false;
  private warned = new Set<string>();
  private buffer: Buffer | null = null;

  constructor(
    readonly config: VaultConfig,
    private options: VaultOptions = {},
  ) {}

  get index(): RecallIndex | null {
    return this.current;
  }

  get stats(): ScanStats | null {
    return this.lastStats;
  }

  /** The notes of the last scan, in folder order. */
  get notes(): VaultNote[] {
    const out: VaultNote[] = [];
    for (const entry of this.files.values()) if (entry.note && !isBlocked(entry.note)) out.push(entry.note);
    return out;
  }

  get blocked(): BlockedNote[] {
    const out: BlockedNote[] = [];
    for (const entry of this.files.values()) if (entry.note && isBlocked(entry.note)) out.push(entry.note);
    return out;
  }

  /** True when the index changed. Never throws. A forced call during a scan returns false; the running scan's promise resolves after its rerun. */
  refresh(force = false): Promise<boolean> {
    if (this.scanning) {
      if (force) this.rerun = true;
      if (!this.warnedSlow && Date.now() - this.scanStartedAt > SCAN_WARN_MS) {
        this.warnedSlow = true;
        log.warn("vault scan still running; the last index stays in use", { seconds: Math.round((Date.now() - this.scanStartedAt) / 1000) });
      }
      return Promise.resolve(false);
    }
    if (!force && Date.now() - this.lastScanAt < RESCAN_MS) return Promise.resolve(false);
    this.scanning = this.scanLoop();
    return this.scanning;
  }

  private async scanLoop(): Promise<boolean> {
    let changed = false;
    try {
      do {
        this.rerun = false;
        this.warnedSlow = false;
        this.scanStartedAt = Date.now();
        if (await this.scan()) changed = true;
        this.lastScanAt = Date.now();
      } while (this.rerun);
    } catch (error) {
      log.warn("vault scan failed; the last index stays in use", { error: String(error) });
    } finally {
      this.scanning = null;
    }
    return changed;
  }

  private warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(message, fields);
  }

  /** Finds a configured folder below the root by its on-disk names. Refuses symlinks and files. */
  private async resolveFolder(root: string, folder: string): Promise<string | null> {
    let rel = "";
    for (const part of folder.split("/")) {
      const dir = rel ? join(root, rel) : root;
      let found: string | null = null;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const match = entries.find((e) => norm(e.name) === norm(part));
        if (match) {
          if (!match.isDirectory()) {
            this.warnOnce("folder:" + folder, "recall folder skipped: not a folder or a symlink", { folder });
            return null;
          }
          found = match.name;
        }
      } catch {
        found = null;
      }
      if (!found) {
        this.warnOnce("folder:" + folder, "recall folder skipped: not found", { folder });
        return null;
      }
      rel = rel ? rel + "/" + found : found;
    }
    // Last check on the full path, in case it changed between the listing and now.
    try {
      const st = await lstat(join(root, rel));
      if (st.isSymbolicLink() || !st.isDirectory()) {
        this.warnOnce("folder:" + folder, "recall folder skipped: not a folder or a symlink", { folder });
        return null;
      }
    } catch {
      return null;
    }
    this.warned.delete("folder:" + folder);
    return rel;
  }

  private async scan(): Promise<boolean> {
    const started = performance.now();
    let root: string;
    try {
      root = await realpath(this.config.root);
      await readdir(root);
    } catch (error) {
      if (!this.rootDown) log.warn("vault not reachable; recall keeps its last index", { error: (error as NodeJS.ErrnoException).code ?? String(error) });
      this.rootDown = true;
      return false;
    }
    if (this.rootDown) log.info("vault reachable again");
    this.rootDown = false;

    const max = this.options.maxNotes ?? MAX_INDEX_NOTES;
    const seen = new Set<string>();
    const counts = { read: 0, skipped: 0, evicted: 0 };
    let capped = false;

    const readFileAt = async (abs: string, rel: string): Promise<void> => {
      let st;
      try {
        st = await lstat(abs);
      } catch {
        counts.skipped++;
        return;
      }
      if (!st.isFile()) {
        counts.skipped++;
        return;
      }
      seen.add(rel);
      const prev = this.files.get(rel);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
      if (st.size > 0 && st.blocks === 0) {
        // iCloud placeholder, not downloaded: never forces a download.
        counts.evicted++;
        if (!prev) seen.delete(rel);
        return;
      }
      counts.read++;
      try {
        const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        let head: { text: string; mtimeMs: number; size: number } | null;
        try {
          const fst = await handle.stat();
          const buffer = (this.buffer ??= Buffer.alloc(HEAD_BYTES));
          const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
          const bytes = buffer.subarray(0, bytesRead);
          if (bytes.includes(0)) {
            head = null;
          } else {
            let text = bytes.toString("utf8");
            if (bytesRead === HEAD_BYTES && fst.size > HEAD_BYTES) text = text.replace(/�+$/, "");
            // A short read means the file changed while it was read: use it, but read it again next time.
            const size = bytesRead === Math.min(fst.size, HEAD_BYTES) ? fst.size : -1;
            head = { text, mtimeMs: fst.mtimeMs, size };
          }
          if (!head) {
            counts.skipped++;
            this.files.set(rel, { mtimeMs: fst.mtimeMs, size: fst.size, note: null });
          }
        } finally {
          await handle.close();
        }
        if (head) {
          const note = parseNote(rel, head.text, head.mtimeMs, this.config);
          this.files.set(rel, { mtimeMs: head.mtimeMs, size: head.size, note });
        }
      } catch (error) {
        counts.skipped++;
        this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, note: null });
        log.debug("vault note skipped", { path: rel, error: (error as NodeJS.ErrnoException).code ?? String(error) });
      }
      await this.options.onFile?.(rel);
    };

    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (error) {
        log.debug("vault folder skipped", { path: rel, error: (error as NodeJS.ErrnoException).code ?? String(error) });
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (capped) return;
        if (entry.name.startsWith(".")) continue;
        const childRel = rel ? rel + "/" + entry.name : entry.name;
        if (excluded(childRel, this.config.exclude)) continue;
        if (entry.isDirectory()) {
          await walk(join(abs, entry.name), childRel);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (!lower.endsWith(".md") || lower.endsWith(".excalidraw.md") || SKIP_NAME.test(entry.name)) continue;
          if (seen.has(childRel)) continue;
          if (seen.size >= max) {
            capped = true;
            this.warnOnce("cap", "vault recall note cap reached; later folders are not indexed", { max });
            return;
          }
          await readFileAt(join(abs, entry.name), childRel);
        }
        // Anything else (a symlink, a socket) is never followed.
      }
    };

    for (const folder of this.config.folders) {
      if (capped) break;
      const rel = folder === "" ? "" : await this.resolveFolder(root, folder);
      if (rel === null) continue;
      await walk(rel ? join(root, rel) : root, rel);
    }

    let removed = 0;
    for (const path of [...this.files.keys()]) {
      if (!seen.has(path)) {
        this.files.delete(path);
        removed++;
      }
    }
    const changed = counts.read > 0 || removed > 0 || this.current === null;
    let buildMs = 0;
    if (changed) {
      const buildStart = performance.now();
      this.current = buildIndex(this.notes, this.blocked, this.config.self);
      buildMs = Math.round(performance.now() - buildStart);
    }
    this.lastStats = {
      files: seen.size,
      read: counts.read,
      removed,
      skipped: counts.skipped,
      evicted: counts.evicted,
      ms: Math.round(performance.now() - started),
      buildMs,
      capped,
    };
    if (changed) {
      log.info("vault indexed", {
        notes: this.current?.notes ?? 0,
        subjects: this.current?.subjects.size ?? 0,
        read: counts.read,
        removed,
        skipped: counts.skipped,
        evicted: counts.evicted,
        ms: this.lastStats.ms,
        buildMs,
      });
    }
    return changed;
  }
}
