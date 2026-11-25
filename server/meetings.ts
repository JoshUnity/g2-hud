import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log";
import {
  digestBody,
  fileStamp,
  renderDraftHeader,
  renderLine,
  renderNote,
  safeFileName,
  type MeetingSummary,
  type NoteAnswer,
  type NoteLine,
} from "./notes";
import { parseFrontmatter, recallOff } from "./vault";

const DRAFT_MARK = "(recording)";
/** File names of finished notes: "2026-11-23 14-05 <title>.md". */
const NOTE_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2} .+\.md$/;
/** Draft paths taken by a recorder in this process, so two recordings never share one draft file. */
const claimed = new Set<string>();

/** The vault did not take the transcript. The recorder keeps the conversation in memory. */
export class VaultWriteError extends Error {}

/** Where meeting notes go, or null when no vault is configured. */
export function meetingsFolder(): string | null {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) return null;
  return join(vault, process.env.MEETINGS_FOLDER ?? "Meetings");
}

/**
 * Records one conversation into the vault: the transcript is appended to a
 * draft note as it happens, so nothing is lost if the server stops. When the
 * conversation ends, the draft is replaced by a summarized note.
 */
export class MeetingRecorder {
  private lines: NoteLine[] = [];
  private answers: NoteAnswer[] = [];
  /** Vault notes quoted to Claude in this conversation (vault-relative paths), for the audit section of the note. */
  private recalled = new Set<string>();
  private draftPath: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** A draft write failed in this conversation; the wearer has been told once. */
  private failed = false;

  constructor(
    private folder: string,
    /** Called once per conversation when the live draft cannot be written. */
    private onWriteError: () => void = () => {},
  ) {}

  get lastActivity(): number {
    return this.lines[this.lines.length - 1]?.at.getTime() ?? 0;
  }

  add(line: NoteLine): void {
    if (!this.draftPath) {
      // A draft of the same minute (another recording, or one left by a stopped server) is never reused.
      const base = `${fileStamp(line.at)} Conversation ${DRAFT_MARK}`;
      let path = join(this.folder, `${base}.md`);
      for (let n = 2; claimed.has(path) || existsSync(path); n++) path = join(this.folder, `${base} ${n}.md`);
      claimed.add(path);
      this.draftPath = path;
      this.chain(async () => {
        await mkdir(this.folder, { recursive: true });
        await writeFile(path, renderDraftHeader(line.at));
      });
    }
    this.lines.push(line);
    const path = this.draftPath;
    this.chain(() => appendFile(path, renderLine(line) + "\n"));
  }

  addAnswer(answer: NoteAnswer): void {
    if (this.draftPath) this.answers.push(answer);
  }

  /** Records the vault notes quoted in a request. Like answers, only while a draft exists. */
  addRecalled(paths: string[]): void {
    if (!this.draftPath) return;
    for (const path of paths) this.recalled.add(path);
  }

  /** Ends the conversation. New lines that arrive meanwhile start a new note. */
  async finish(summarize: (lines: NoteLine[]) => Promise<MeetingSummary | null>): Promise<{ title: string; path: string } | null> {
    const { lines, answers, recalled, draftPath, writes } = this;
    this.lines = [];
    this.answers = [];
    this.recalled = new Set();
    this.draftPath = null;
    this.writes = Promise.resolve();
    this.failed = false;
    const first = lines[0];
    if (!first || !draftPath) return null;
    await writes;

    try {
      // Before the paid summary: the whole transcript must be on disk. This also repairs a draft that missed lines.
      await mkdir(this.folder, { recursive: true });
      await writeFile(draftPath, renderDraftHeader(first.at) + lines.map((line) => renderLine(line) + "\n").join(""));
    } catch (error) {
      // Nothing complete is on disk: put the conversation back so a later save can work.
      this.lines = [...lines, ...this.lines];
      this.answers = [...answers, ...this.answers];
      this.recalled = new Set([...recalled, ...this.recalled]);
      this.draftPath ??= draftPath;
      if (this.draftPath !== draftPath) claimed.delete(draftPath);
      throw new VaultWriteError(String(error));
    }

    const summary = await summarize(lines).catch((error: unknown) => {
      log.warn("summary failed; saving transcript only", { error: String(error) });
      return null;
    });
    const title = summary?.title.trim() || "Conversation";
    const base = `${fileStamp(first.at)} ${safeFileName(title)}`;
    let path = join(this.folder, `${base}.md`);
    for (let n = 2; existsSync(path); n++) path = join(this.folder, `${base} ${n}.md`);
    await writeFile(path, renderNote(title, summary, lines, answers, [...recalled].sort()));
    await rm(draftPath, { force: true });
    claimed.delete(draftPath);
    log.info("meeting saved", { path });
    return { title, path };
  }

  private chain(task: () => Promise<void>): void {
    this.writes = this.writes.then(task).catch((error: unknown) => {
      log.error("vault write failed", { error: String(error) });
      if (!this.failed) this.onWriteError();
      this.failed = true;
    });
  }
}

/** True for a note this app wrote. Tolerant of Obsidian rewriting the YAML (quotes removed). */
function isOwnNote(front: string): boolean {
  return /^source:\s*["']?Even G2["']?\s*$/m.test(front);
}

/**
 * Digests of the most recent finished notes, newest first, for recall.
 * Only notes this app wrote count; other notes in the folder are never read into a prompt.
 * A note marked `recall: false` in its frontmatter is skipped and does not count toward the limit,
 * and so is a note whose frontmatter is not closed (it cannot be checked).
 * The opt-out test is recallOff from vault.ts, the same rule that keeps the note out of the recall index.
 * Never rejects: an unreadable entry is skipped.
 */
export async function recentMeetings(folder: string, limit = 8, maxChars = 12_000): Promise<string> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return "";
  }
  const finished = names.filter((name) => NOTE_NAME.test(name) && !name.includes(DRAFT_MARK)).sort().reverse();
  const parts: string[] = [];
  let used = 0;
  let own = 0;
  for (const name of finished) {
    if (own >= limit) break;
    let markdown: string;
    try {
      markdown = await readFile(join(folder, name), "utf8");
    } catch (error) {
      log.warn("could not read meeting note; skipped for recall", { name, error: String(error) });
      continue;
    }
    const { front, body, closed } = parseFrontmatter(markdown);
    if (!closed || !isOwnNote(front) || recallOff(front)) continue;
    own++;
    const text = `### ${name.replace(/\.md$/, "")}\n${digestBody(body)}`;
    // One large note does not push out the older ones.
    if (used + text.length > maxChars) continue;
    parts.push(text);
    used += text.length;
  }
  return parts.join("\n\n");
}
