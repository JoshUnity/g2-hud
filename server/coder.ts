import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { query, type HookCallback, type PermissionResult, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CodeView } from "../src/core/protocol";
import { log } from "./log";

/**
 * Claude Code, driven from the glasses. Runs in one project folder (a CODE_DIRS entry),
 * keeps the conversation between instructions, and asks on the glasses before
 * anything that is not reading or editing files inside the project.
 */

const APPROVAL_TIMEOUT_MS = 120_000;
/**
 * An allow for a request that went on show less than this long ago is ignored, whatever client sends it:
 * a second click on the phone page must not allow the next queued request unread. As MIN_SEEN_MS on the glasses.
 */
export const MIN_SHOWN_MS = 700;
const LOG_LINES = 40;

/** Tools that only track the plan. */
const PLAN = new Set(["TodoWrite"]);
/** Subagents: their own tool calls still come through the policy. */
const AGENTS = new Set(["Task", "Agent"]);
/** Tools that read or search, named in `file_path`, `notebook_path` or `path` (default: the project). */
const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
/** Tools that edit one file, named in `file_path` or `notebook_path`. */
const FILE_EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Files at the top of a folder that is not a git repository that would make git read it as one (with its config). */
const BARE_REPO_FILES = new Set(["head", "config", "commondir", "packed-refs"]);
const BARE_REPO_DIRS = new Set(["objects", "refs"]);

export type Decision = "allow" | "ask";

/** Mac disks ignore case and read the long s as "s": compare a folded path, so .GIT is .git. */
const fold = (path: string) => path.normalize("NFC").toLowerCase().replace(/ſ/g, "s");

/** The real path of a file that may not exist yet: links resolved in the part that exists. Null for a dangling link. */
function realTarget(full: string): string | null {
  let head = full;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(head);
      break;
    } catch {
      const up = dirname(head);
      if (up === head) return full;
      tail.unshift(basename(head));
      head = up;
    }
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return null;
  }
}

/**
 * Claude Code expands a leading "~" itself (Grep and Glob pass it to the server as typed), so
 * "~/.aws" is the home folder, not a folder named "~" in the project. Null for any other "~" form
 * ("~user/…"): it is not judged, so it asks.
 */
function expandHome(path: string): string | null {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("~") ? null : path;
}

/** A path relative to the project root, judged on where it really lands. Null when it leaves the project. */
function landing(target: string, root: string): { lexical: string; real: string } | null {
  const expanded = expandHome(target);
  if (expanded === null) return null;
  const full = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  const real = realTarget(full);
  if (real === null) return null;
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return { lexical: relative(root, full), real: rel };
}

/**
 * Paths that can make something run without a tool call: git internals, .env files,
 * Claude Code's own settings (.claude: hooks, permission rules) and MCP servers (.mcp.json).
 */
function sensitive(rel: string, root: string): boolean {
  const parts = fold(rel).split(sep);
  const name = parts[parts.length - 1] ?? "";
  if (parts.includes(".git") || parts.includes(".claude") || name === ".mcp.json") return true;
  if (parts.some((p) => p === ".env" || p.startsWith(".env."))) return true;
  // Without its own .git, git takes the folder itself as a bare repository when HEAD, objects and refs are there.
  if (!existsSync(join(root, ".git"))) {
    const first = parts[0] ?? "";
    if ((parts.length === 1 && BARE_REPO_FILES.has(first)) || BARE_REPO_DIRS.has(first)) return true;
  }
  return false;
}

/** Whether a tool call may run on its own, or must be approved on the glasses. */
export function policy(tool: string, input: Record<string, unknown>, root: string): Decision {
  if (PLAN.has(tool)) return "allow";
  // An isolated agent makes a git worktree and branch (or runs remotely): ask.
  if (AGENTS.has(tool)) return input.isolation === undefined ? "allow" : "ask";
  if (READS.has(tool)) {
    const target = input.file_path ?? input.notebook_path ?? input.path ?? root;
    if (typeof target !== "string" || landing(target, root) === null) return "ask";
    const pattern = input.pattern;
    if (tool === "Glob" && typeof pattern === "string") {
      if (pattern.split(/[\\/{},]/).includes("..")) return "ask";
      const expanded = expandHome(pattern);
      if (expanded === null || (isAbsolute(expanded) && landing(expanded, root) === null)) return "ask";
    }
    return "allow";
  }
  if (FILE_EDITS.has(tool)) {
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== "string") return "ask";
    const spot = landing(target, root);
    if (spot === null || spot.real === "") return "ask";
    return sensitive(spot.real, root) || sensitive(spot.lexical, root) ? "ask" : "allow";
  }
  return "ask"; // Bash, web, MCP tools and anything new
}

/**
 * Claude Code approves the Agent tool itself, before it asks the server, so an
 * isolated agent is stopped by a PreToolUse hook instead.
 */
export function agentGate(root: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (policy(input.tool_name, toolInput, root) === "allow") return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Isolated agents (worktree or remote) are not available from the glasses. Run the agent without isolation.",
      },
    };
  };
}

/** The lines of a text: none for "", else the number of lines (a final line break does not start another). */
const lineCount = (text: unknown): number => (typeof text === "string" && text !== "" ? text.replace(/\n$/, "").split("\n").length : 0);

/** The lines a file edit adds and removes, from its input (Edit, MultiEdit, Write, NotebookEdit); 0 and 0 for anything else. */
export function editedLines(tool: string, input: Record<string, unknown>): { added: number; removed: number } {
  switch (tool) {
    case "Edit":
      return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      let added = 0;
      let removed = 0;
      for (const e of edits) {
        added += lineCount(e?.new_string);
        removed += lineCount(e?.old_string);
      }
      return { added, removed };
    }
    case "Write":
      return { added: lineCount(input.content), removed: 0 };
    case "NotebookEdit":
      return { added: lineCount(input.new_source), removed: 0 };
    default:
      return { added: 0, removed: 0 };
  }
}

/** Shell programs and sub-commands that reach the network. The note "needs network" is shown only for these, so it is never wrong the other way. */
const NETWORK_COMMAND =
  /(^|[\s;&|(`$])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ping|dig|nslookup|npx|pipx|git\s+(clone|fetch|pull|push)|npm\s+(install|i|ci|add|update|publish|view|info|audit)|pnpm\s+(install|i|add|update|dlx)|yarn(\s+(install|add|up|dlx))?|bun\s+(install|i|add|x)|pip3?\s+install|uv\s+(pip|add|sync)|cargo\s+(install|add|fetch|update|publish)|go\s+(get|install)|brew\s+(install|update|upgrade)|apt(-get)?\s+(install|update|upgrade)|docker\s+(pull|push|login)|gh)(\s|$)/;

/** Whether a call clearly needs the network: the web tools, and shell commands that name a networked program. */
export function needsNetwork(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "WebFetch" || tool === "WebSearch") return true;
  return tool === "Bash" && typeof input.command === "string" && NETWORK_COMMAND.test(input.command);
}

/** The folder for the card: "~" for the home folder, and the tail when it is longer than the view allows (80). */
export function shortFolder(root: string): string {
  const home = homedir();
  const text = root === home ? "~" : root.startsWith(home + sep) ? `~${root.slice(home.length)}` : root;
  return text.length > 80 ? `…${text.slice(-79)}` : text;
}

/** The most files a view lists, and the longest path it may carry (the schema in src/core/protocol.ts refuses more). */
export const MAX_FILES = 24;
const MAX_PATH = 120;
/**
 * The project file a tool call touches: a path relative to the project root with "/" separators, and
 * whether it was read or edited. Null for a call with no file, a folder, a path outside the project (links
 * resolved), or a path longer than the view allows.
 */
export function touchedFile(tool: string, input: Record<string, unknown>, root: string): { path: string; state: "read" | "edit" } | null {
  const state = FILE_EDITS.has(tool) ? "edit" : READS.has(tool) ? "read" : null;
  if (!state) return null;
  const target = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof target !== "string" || !target) return null;
  const spot = landing(target, root);
  if (!spot) return null;
  const rel = spot.lexical.split(sep).join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.length > MAX_PATH) return null;
  // A search or a listing names a folder as often as a file; only a file is a touched file.
  if (state === "read" && tool !== "Read" && tool !== "NotebookRead") {
    try {
      if (!statSync(join(root, rel)).isFile()) return null;
    } catch {
      return null;
    }
  }
  return { path: rel, state };
}

/** Folders and files the tree count skips, and its limits: 3 levels deep, 200 files counted, 2000 entries looked at. */
const TREE_SKIP = new Set(["node_modules"]);
const TREE_DEPTH = 3;
const TREE_COUNT = 200;
const TREE_LOOKED = 2000;
export const MAX_FOLDERS = 12;

function countFiles(dir: string, depth: number, budget: { files: number; looked: number }): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files >= TREE_COUNT || budget.looked >= TREE_LOOKED) return;
    if (entry.name.startsWith(".") || TREE_SKIP.has(entry.name)) continue;
    budget.looked++;
    if (entry.isFile()) budget.files++;
    else if (entry.isDirectory() && depth < TREE_DEPTH) countFiles(join(dir, entry.name), depth + 1, budget);
  }
}

/**
 * The top-level folders of a project with a file count each, for the file map: no hidden folders, no
 * node_modules, no links. At most MAX_FOLDERS (the fullest ones), in name order. Cheap by design.
 */
export function projectTree(root: string): { name: string; files: number }[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !TREE_SKIP.has(e.name) && e.name.length <= 40)
    .map((e) => {
      const budget = { files: 0, looked: 0 };
      countFiles(join(root, e.name), 1, budget);
      return { name: e.name, files: budget.files };
    });
  return folders
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, MAX_FOLDERS)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

/** One line for the glasses about a tool call. */
export function describeTool(tool: string, input: Record<string, unknown>, root: string): string {
  const path = (key: string) => {
    const v = input[key];
    if (typeof v !== "string") return "";
    const rel = relative(root, isAbsolute(v) ? v : resolve(root, v));
    return rel.startsWith("..") ? v : rel;
  };
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (tool) {
    case "Bash":
      return `$ ${clip(str("command"), 70)}`;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `${tool} ${path("file_path")}`;
    case "NotebookEdit":
      return `Edit ${path("notebook_path")}`;
    case "Grep":
      return `Search “${clip(str("pattern"), 40)}”`;
    case "Glob":
      return `Find ${clip(str("pattern"), 50)}`;
    case "Task":
    case "Agent":
      return `Agent: ${clip(str("description"), 50)}`;
    case "TodoWrite":
      return "Plan updated";
    case "WebFetch":
      return `Fetch ${clip(str("url"), 60)}`;
    case "WebSearch":
      return `Search the web “${clip(str("query"), 40)}”`;
    default:
      return clip(`${tool} ${JSON.stringify(input)}`, 70);
  }
}

/** Approval text longer than this is denied: nobody can review it on the glasses. */
export const APPROVAL_TEXT_MAX = 3000;

/**
 * Every character the glasses can draw; the rest is shown as \u{…}, because the font drops unknown glyphs silently.
 * The firmware font has no backtick (U+0060), so a backtick (shell command substitution) shows as \u{60}.
 * A real backslash that starts what looks like such an escape ("\u{") shows as \u{5c}, so typed text can never pass for
 * an escape: every "\u{" the wearer reads is one this function wrote.
 */
const visible = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\\(?=u\{)/g, "\\u{5c}")
    .replace(/[^\x20-\x5f\x61-\x7e\n]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);

/**
 * The whole tool call, as the wearer must see it to approve it: nothing cut,
 * newlines kept. describeTool() is the short form for the log.
 */
export function approvalText(tool: string, input: Record<string, unknown>, root: string): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const path = (key: string) => {
    const v = expandHome(str(key)) ?? str(key);
    const full = isAbsolute(v) ? resolve(v) : resolve(root, v);
    const rel = relative(root, full);
    const shown = visible(rel.startsWith("..") || isAbsolute(rel) ? full : rel);
    const real = realTarget(full);
    if (real === null) return `${shown} → (broken link)`;
    return real === full ? shown : `${shown} → ${visible(real)}`;
  };
  /**
   * The card is the whole call: every input key that the summary above does not show follows it, as
   * "name: value". A tap must never allow a call that differs from what was read (a background run, a
   * timeout, a sandbox switch, the prompt of a fetch).
   */
  const rest = (...shown: string[]) =>
    Object.entries(input)
      .filter(([key]) => !shown.includes(key))
      .map(([key, value]) => `\n${visible(key)}: ${visible(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)))}`)
      .join("");
  /** The keys whose string value the summary shows (a key of another type is not shown, so it is listed in `rest`). */
  const text = (...keys: string[]) => keys.filter((key) => typeof input[key] === "string");
  switch (tool) {
    case "Bash":
      return `$ ${visible(str("command"))}${rest(...text("command"))}`;
    case "Write": // the content too: a hook or an MCP server is written in it
      return `Write ${path("file_path")}\n${visible(str("content"))}${rest(...text("file_path", "content"))}`;
    case "Edit": // replace_all changes every match, not one
      return `Edit ${path("file_path")}${input.replace_all === true ? " (every match)" : ""}\n- ${visible(str("old_string"))}\n+ ${visible(str("new_string"))}${rest(...text("file_path", "old_string", "new_string"), ...(input.replace_all === true ? ["replace_all"] : []))}`;
    case "MultiEdit":
    case "Read":
      return `${tool} ${path("file_path")}${Array.isArray(input.edits) ? `\n${visible(JSON.stringify(input.edits))}` : ""}${rest(...text("file_path"), ...(Array.isArray(input.edits) ? ["edits"] : []))}`;
    case "NotebookEdit": {
      // The cell and the source it gets (an insert adds a new cell after cell_id).
      const cell = [str("edit_mode") || "replace", "cell", str("cell_id"), str("cell_type") && `(${str("cell_type")})`].filter(Boolean).join(" ");
      return `Edit ${path("notebook_path")}\n${visible(cell)}\n${visible(str("new_source"))}${rest(...text("notebook_path", "edit_mode", "cell_id", "cell_type", "new_source"))}`;
    }
    case "WebFetch":
      return `Fetch ${visible(str("url"))}${rest(...text("url"))}`;
    default:
      return visible(`${tool} ${JSON.stringify(input)}`);
  }
}

/** CODE_BUDGET_USD: a number greater than 0, or the default 2. The CLI refuses anything else and every task would fail. */
export function budgetUsd(): number {
  const raw = process.env.CODE_BUDGET_USD?.trim();
  const value = Number(raw);
  if (raw && value > 0) return value;
  if (raw) log.warn("CODE_BUDGET_USD is not a number greater than 0; using 2", { value: raw });
  return 2;
}

/**
 * The diff size for the glasses. The project is writable by Claude, so git runs with
 * nothing the repository can configure to run a command: no fsmonitor, hooks, external
 * diff or textconv, and no bare repository found by discovery.
 */
export function gitStat(cwd: string): Promise<string> {
  const args = [
    ...["-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-pager"],
    ...["-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--shortstat"],
  ];
  return new Promise((done) => {
    execFile("git", args, { timeout: 5000 }, (error, stdout) => {
      done(error ? "" : stdout.trim().replace(/ changed/, "").replace(/insertions?\(\+\)/, "+").replace(/deletions?\(-\)/, "−"));
    });
  });
}

const GLASSES_NOTE = `You are being driven by voice through smart glasses. The person sees about six short lines of text and cannot read long output. Keep messages to one or two short sentences. When you finish, end with a one-line summary of what changed. Instructions arrive as speech-to-text and may contain mishearings: if one is ambiguous in a way that matters, ask one short question instead of guessing.`;

export class Coder {
  readonly root: string;
  private sessionId: string | null = null;
  private running: Query | null = null;
  private abort: AbortController | null = null;
  private pending: { id: number; shownAt: number; resolve: (allow: boolean) => void } | null = null;
  private nextId = 1;
  /** Requests wait here for their turn: the glasses show one at a time. */
  private approvals: Promise<unknown> = Promise.resolve();
  view: CodeView;
  /** The project folder as the card shows it. */
  private readonly folder: string;

  constructor(
    dir: string,
    private onChange: (view: CodeView) => void,
  ) {
    if (!existsSync(dir)) throw new Error(`Folder in CODE_DIRS does not exist: ${dir}`);
    this.root = realpathSync(dir);
    this.view = {
      state: "idle",
      project: basename(this.root),
      prompt: "",
      log: [],
      approval: null,
      result: "",
      stats: "",
      error: "",
      startedAt: null,
      files: [],
      current: null,
      tree: projectTree(this.root),
    };
    this.folder = shortFolder(this.root);
  }

  private set(patch: Partial<CodeView>): void {
    this.view = { ...this.view, ...patch };
    this.onChange(this.view);
  }

  /** Notes a file the task touched: once, in the order first touched, with the stronger state, and the newest MAX_FILES. */
  private touch(file: { path: string; state: "read" | "edit" }): void {
    const files = this.view.files ?? [];
    const at = files.findIndex((f) => f.path === file.path);
    const next =
      at < 0
        ? [...files, file].slice(-MAX_FILES)
        : files.map((f, i) => (i === at && file.state === "edit" ? { ...f, state: "edit" as const } : f));
    this.set({ files: next, current: file.path });
  }

  private addLog(line: string): void {
    this.set({ log: [...this.view.log, line].slice(-LOG_LINES) });
  }

  /** The person is speaking (push-to-talk held) or the transcript is being made. */
  setInput(state: "recording" | "transcribing" | "idle", note = ""): void {
    if (this.running) return;
    this.set({ state, error: note });
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async run(prompt: string): Promise<void> {
    if (this.running) {
      this.addLog("Still working; double tap to stop first.");
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    // Ends approval requests still waiting when the run ends.
    const ended = new AbortController();
    this.set({ state: "working", prompt, log: [], result: "", stats: "", error: "", approval: null, startedAt: Date.now(), files: [], current: null, added: 0, removed: 0 });
    const q = query({
      prompt,
      options: {
        cwd: this.root,
        abortController: abort,
        resume: this.sessionId ?? undefined,
        model: process.env.CODE_MODEL || undefined,
        permissionMode: "default",
        // Project rules (CLAUDE.md, project hooks and settings) apply; user-level allow rules don't
        // quietly skip the glasses approval.
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: GLASSES_NOTE },
        maxTurns: 60,
        maxBudgetUsd: budgetUsd(),
        hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [agentGate(this.root)] }] },
        canUseTool: (tool, input, { signal }) => this.decide(tool, input, AbortSignal.any([signal, abort.signal, ended.signal])),
      },
    });
    this.running = q;
    try {
      for await (const message of q) this.handle(message);
    } catch (error) {
      if (!abort.signal.aborted) {
        log.error("coder run failed", { error: String(error) });
        this.set({ state: "error", error: error instanceof Error ? error.message : String(error), current: null });
      }
    } finally {
      this.running = null;
      this.abort = null;
      ended.abort();
      if (abort.signal.aborted) this.set({ state: "done", approval: null, current: null, result: this.view.result || "Stopped.", stats: await this.stats() });
    }
  }

  /** What the glasses show when a task ends: the diff size and how long it took. Never spend. */
  private async stats(): Promise<string> {
    const diff = await gitStat(this.root);
    const seconds = this.view.startedAt ? Math.round((Date.now() - this.view.startedAt) / 1000) : 0;
    return [diff, `${seconds}s`].filter(Boolean).join("  ·  ");
  }

  private handle(message: SDKMessage): void {
    if (message.type === "system" && "subtype" in message && message.subtype === "init") {
      this.sessionId = message.session_id;
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) this.addLog(clip(block.text, 120));
        else if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          this.addLog(`› ${describeTool(block.name, input, this.root)}`);
          // A call with no file (a shell command) leaves the current file as it was: the work is still on it.
          const file = touchedFile(block.name, input, this.root);
          if (file) this.touch(file);
          const edited = editedLines(block.name, input);
          if (edited.added || edited.removed) this.set({ added: (this.view.added ?? 0) + edited.added, removed: (this.view.removed ?? 0) + edited.removed });
        }
      }
      return;
    }
    if (message.type === "result") {
      const result = "result" in message && typeof message.result === "string" ? message.result : "";
      const failed = message.subtype !== "success";
      // Spend stays off the glasses by choice; the budget cap still applies.
      void this.stats().then((stats) =>
        this.set({
          state: failed ? "error" : "done",
          approval: null,
          current: null,
          result: result || (failed ? "" : "Done."),
          error: failed ? `Stopped: ${message.subtype.replace(/_/g, " ")}` : "",
          stats,
        }),
      );
    }
  }

  /** The SDK asks for several tools at once (parallel fetches, subagents); the glasses show one request at a time. */
  private decide(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    if (policy(tool, input, this.root) === "allow") return Promise.resolve({ behavior: "allow", updatedInput: input });
    const text = approvalText(tool, input, this.root);
    if (text.length > APPROVAL_TEXT_MAX) {
      this.addLog(`■ denied, too long to show: ${describeTool(tool, input, this.root)}`);
      return Promise.resolve({ behavior: "deny", message: `Too long to review on the glasses (over ${APPROVAL_TEXT_MAX} characters). Use a shorter command, or split it.` });
    }
    const result = this.approvals.then(() => this.ask(tool, input, text, signal));
    this.approvals = result.catch(() => undefined);
    return result;
  }

  private async ask(tool: string, input: Record<string, unknown>, text: string, signal: AbortSignal): Promise<PermissionResult> {
    const denied: PermissionResult = { behavior: "deny", message: "Denied on the glasses. Find another way or ask." };
    // Stopped, cancelled or ended while it waited its turn: never show it.
    if (signal.aborted) return denied;
    const id = this.nextId++;
    const summary = describeTool(tool, input, this.root);
    this.set({
      state: "approval",
      approval: { id, summary, text, tool: tool.toUpperCase().slice(0, 24), cwd: this.folder, ...(needsNetwork(tool, input) ? { network: true } : {}) },
    });
    const allow = await new Promise<boolean>((resolveDecision) => {
      const timer = setTimeout(() => resolveDecision(false), APPROVAL_TIMEOUT_MS);
      signal.addEventListener("abort", () => resolveDecision(false), { once: true });
      this.pending = {
        id,
        shownAt: Date.now(),
        resolve: (ok) => {
          clearTimeout(timer);
          resolveDecision(ok);
        },
      };
    });
    this.pending = null;
    // After the run has ended, leave its final state alone.
    this.set(this.running ? { state: "working", approval: null } : { approval: null });
    this.addLog(allow ? `● allowed: ${summary}` : `■ denied: ${summary}`);
    return allow ? { behavior: "allow", updatedInput: input } : denied;
  }

  /** The answer from the glasses (or the phone page) for one pending request. A stale id, or an allow too soon after it went on show, is ignored. */
  decideFromGlasses(id: number, allow: boolean): void {
    if (this.pending?.id !== id) return;
    if (allow && Date.now() - this.pending.shownAt < MIN_SHOWN_MS) return;
    this.pending.resolve(allow);
  }

  stop(): void {
    this.pending?.resolve(false);
    this.abort?.abort();
  }

  reset(): void {
    if (this.running) return;
    this.sessionId = null;
    this.set({ state: "idle", prompt: "", log: [], result: "", stats: "", error: "", approval: null, startedAt: null, files: [], current: null, tree: projectTree(this.root), added: undefined, removed: undefined });
  }
}
