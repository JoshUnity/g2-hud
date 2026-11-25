import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MeetingRecorder, VaultWriteError, recentMeetings } from "../server/meetings";
import { fileStamp, type MeetingSummary } from "../server/notes";
import { parseNote } from "../server/vault";

const summary = (title: string): MeetingSummary => ({
  title,
  summary: `Summary of ${title}.`,
  decisions: [],
  action_items: [],
  people: [],
  topics: [],
});

const at = (h: number, m: number, s: number) => new Date(2026, 10, 25, h, m, s);
const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "g2hud-meet-"));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
/** The text of every draft in the folder. */
const draftTexts = async (dir: string) =>
  Promise.all((await readdir(dir)).filter((name) => name.includes("(recording)")).map((name) => readFile(join(dir, name), "utf8")));

/** recall: false forms that the index blocks (see test/vault.test.ts). The past-meeting notes must skip each one. */
const OPT_OUT = [
  "recall: false",
  "recall: False",
  "Recall: FALSE",
  "recall: false # x",
  'recall: "false" # x',
  "recall: 'false' # private",
  "recall: [false] # x",
  "recall: [ 'false' ]",
  '"recall": false',
  "recall : false",
  "  recall: false",
  "recall:\n  - false",
  "recall: # private\n  - false",
  "recall:\n  - 'false' # x",
  "recall:\n\n  - false",
  "recall:\n  # private\n  - false",
  "recall:\n  false",
  "recall: [\n  false\n]",
  "recall: !!bool false",
];

/** A note as MeetingRecorder writes it, without the summary call. */
async function g2Note(dir: string, h: number, title: string, source = 'source: "Even G2"'): Promise<void> {
  const name = `2026-11-2${h % 10} 10-00 ${title}.md`;
  await writeFile(join(dir, name), `---\n${source}\ntags: [meeting]\n---\n# ${title}\n\nG2SUMMARY ${title}\n\n## Transcript\n\n- secret line\n`);
}

describe("MeetingRecorder when the vault cannot be written", () => {
  it("tells the wearer once, keeps the conversation, and saves it when the folder works again", async () => {
    const root = await tempDir();
    // A regular file where a folder should be: every write under it fails (ENOTDIR).
    await writeFile(join(root, "Vault"), "not a folder");
    const folder = join(root, "Vault", "Meetings");
    const onWriteError = vi.fn();
    const recorder = new MeetingRecorder(folder, onWriteError);
    recorder.add({ at: at(9, 0, 0), speaker: "other", text: "First line" });
    recorder.add({ at: at(9, 0, 30), speaker: "self", text: "Second line" });
    recorder.add({ at: at(9, 1, 0), speaker: "other", text: "Third line" });
    const summarize = vi.fn(async () => summary("Budget talk"));

    await expect(recorder.finish(summarize)).rejects.toBeInstanceOf(VaultWriteError);
    expect(onWriteError).toHaveBeenCalledTimes(1);
    // The paid summary is not called while nothing complete is on disk.
    expect(summarize).not.toHaveBeenCalled();
    expect(recorder.lastActivity).toBeGreaterThan(0);

    await rm(join(root, "Vault"));
    const saved = await recorder.finish(summarize);
    expect(saved?.title).toBe("Budget talk");
    const files = await readdir(folder);
    expect(files).toEqual(["2026-11-25 09-00 Budget talk.md"]);
    const text = await readFile(join(folder, files[0] ?? ""), "utf8");
    expect(text).toContain("First line");
    expect(text).toContain("Third line");
  });

  it("keeps the recalled vault notes when the save fails, and writes them later", async () => {
    const root = await tempDir();
    await writeFile(join(root, "Vault"), "not a folder");
    const folder = join(root, "Vault", "Meetings");
    const recorder = new MeetingRecorder(folder);
    recorder.add({ at: at(9, 0, 0), speaker: "other", text: "Hi Sarah" });
    recorder.addRecalled(["People/Sarah Chen.md"]);
    await expect(recorder.finish(async () => summary("Budget talk"))).rejects.toBeInstanceOf(VaultWriteError);

    await rm(join(root, "Vault"));
    await recorder.finish(async () => summary("Budget talk"));
    const text = await readFile(join(folder, "2026-11-25 09-00 Budget talk.md"), "utf8");
    expect(text).toContain("## Vault notes sent to Claude\n\n- [[People/Sarah Chen]]\n");
  });
});

describe("MeetingRecorder drafts", () => {
  it("never deletes another recording's draft of the same minute", async () => {
    const dir = await tempDir();
    const first = new MeetingRecorder(dir);
    first.add({ at: at(14, 5, 5), speaker: "other", text: "A line 1" });
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const saving = first.finish(async () => {
      await slow;
      return summary("First talk");
    });
    // A second recording (a long press, or a new socket) starts in the same minute while the first one is saved.
    const second = new MeetingRecorder(dir);
    second.add({ at: at(14, 5, 40), speaker: "other", text: "B line 1" });
    await vi.waitFor(async () => expect((await draftTexts(dir)).some((t) => t.includes("B line 1"))).toBe(true));
    release();
    await saving;
    const files = (await readdir(dir)).sort();
    expect(files).toContain("2026-11-25 14-05 First talk.md");
    const drafts = files.filter((name) => name.includes("(recording)"));
    expect(drafts).toHaveLength(1);
    expect(await readFile(join(dir, drafts[0] ?? ""), "utf8")).toContain("B line 1");
  });

  it("does not overwrite a draft left by a stopped server", async () => {
    const dir = await tempDir();
    // A draft from an earlier server process: on disk, but never claimed in this one.
    const left = join(dir, `${fileStamp(at(9, 30, 2))} Conversation (recording).md`);
    await writeFile(left, "- 09:30:02 **Them:** said before the server stopped\n");
    const restarted = new MeetingRecorder(dir);
    restarted.add({ at: at(9, 30, 50), speaker: "other", text: "said after the restart" });
    await vi.waitFor(async () => expect((await draftTexts(dir)).some((t) => t.includes("said after the restart"))).toBe(true));
    expect(await readdir(dir)).toHaveLength(2);
    expect(await readFile(left, "utf8")).toBe("- 09:30:02 **Them:** said before the server stopped\n");
  });
});

describe("recentMeetings", () => {
  it("reads only notes this app wrote, skips unreadable entries and never rejects", async () => {
    const dir = await tempDir();
    for (let i = 1; i <= 3; i++) await g2Note(dir, i, `G2 meeting ${i}`);
    await g2Note(dir, 4, "Edited in Obsidian", "source: Even G2");
    await writeFile(join(dir, "Weekly sync agenda.md"), "PRIVATE-BODY-TEXT");
    await writeFile(join(dir, "2026-11-30 10-00 My own dated note.md"), "---\ntags: [x]\n---\nPRIVATE-DATED\n");
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `Own note ${i}.md`), "x".repeat(14_000));
    await mkdir(join(dir, "2026-12-01 10-00 Archive.md"));
    await symlink(join(dir, "missing"), join(dir, "2026-12-02 10-00 Link.md"));

    const recall = await recentMeetings(dir);
    expect(recall).toContain("G2SUMMARY G2 meeting 1");
    expect(recall).toContain("G2SUMMARY G2 meeting 3");
    expect(recall).toContain("G2SUMMARY Edited in Obsidian");
    expect(recall).not.toContain("PRIVATE");
    expect(recall).not.toContain("secret line");
    expect(recall).not.toContain("Own note");
  });

  it("skips recall: false notes, in any quoting, and they do not count toward the limit", async () => {
    const dir = await tempDir();
    for (let i = 1; i <= 8; i++) await g2Note(dir, i, `Shared ${i}`);
    await writeFile(join(dir, "2026-11-19 10-00 Oldest.md"), `---\nsource: "Even G2"\n---\nG2SUMMARY Oldest\n`);
    await writeFile(join(dir, "2026-11-30 10-00 Off plain.md"), `---\nsource: "Even G2"\nrecall: false\n---\nOPTED-OUT plain\n`);
    await writeFile(join(dir, "2026-11-30 11-00 Off quoted.md"), `---\nsource: Even G2\nrecall: "false"\n---\nOPTED-OUT quoted\n`);
    await writeFile(join(dir, "2026-11-30 12-00 Off crlf.md"), `---\r\nsource: "Even G2"\r\nrecall: 'false'\r\n---\r\nOPTED-OUT crlf\r\n`);
    await writeFile(join(dir, "2026-11-30 14-00 Off capital.md"), `---\nsource: "Even G2"\nrecall: False\n---\nOPTED-OUT capital\n`);
    await writeFile(join(dir, "2026-11-30 15-00 Off comment.md"), `---\nsource: "Even G2"\nrecall: false # x\n---\nOPTED-OUT comment\n`);
    // Only the frontmatter counts: "recall: false" in the body does not hide a note.
    await writeFile(join(dir, "2026-11-30 13-00 Body mention.md"), `---\nsource: "Even G2"\n---\nG2SUMMARY Body\nrecall: false\n`);
    const recall = await recentMeetings(dir);
    expect(recall).not.toContain("OPTED-OUT");
    expect(recall).toContain("G2SUMMARY Body");
    expect(recall).toContain("G2SUMMARY Shared 8");
    expect(recall).toContain("G2SUMMARY Shared 2");
    // Body mention + Shared 8..2 = 8 own notes; Shared 1 and Oldest are past the limit.
    expect(recall).not.toContain("G2SUMMARY Shared 1");
    expect(recall).not.toContain("G2SUMMARY Oldest");
    expect((recall.match(/^### /gm) ?? []).length).toBe(8);
  });

  it("skips every recall: false form that the index blocks", async () => {
    const dir = await tempDir();
    await g2Note(dir, 1, "Shared");
    await writeFile(join(dir, "2026-11-29 10-00 Kept.md"), `---\nsource: "Even G2"\nrecall: true\n---\nG2SUMMARY Kept\n`);
    for (const [i, line] of OPT_OUT.entries()) {
      const text = `---\nsource: "Even G2"\n${line}\n---\n# Off\n\nOPTED-OUT ${i}\n`;
      // The same note is blocked in the recall index: one rule for both paths.
      expect(parseNote(`Meetings/Off ${i}.md`, text, 0, { people: [], meetings: "Meetings" }), line).toMatchObject({ blocked: true });
      await writeFile(join(dir, `2026-11-30 ${String(i).padStart(2, "0")}-00 Off ${i}.md`), text);
    }
    const recall = await recentMeetings(dir);
    expect(recall).not.toContain("OPTED-OUT");
    expect(recall).toContain("G2SUMMARY Shared");
    expect(recall).toContain("G2SUMMARY Kept");
  });

  it("keeps a body that starts with a rule and skips a note whose frontmatter is not closed", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "2026-11-22 10-00 Rule.md"), '---\nsource: "Even G2"\n---\n---\nRULE-A\n---\nRULE-B\n');
    await writeFile(join(dir, "2026-11-20 10-00 Unclosed.md"), '---\nsource: "Even G2"\npeople: [x]\n\nUNCLOSED-BODY\n');
    const recall = await recentMeetings(dir);
    expect(recall).toContain("RULE-A");
    expect(recall).toContain("RULE-B");
    expect(recall).not.toContain("UNCLOSED");
  });

  it("reads a BOM + CRLF note without its frontmatter or transcript", async () => {
    const dir = await tempDir();
    const crlf = '\u{FEFF}---\nsource: "Even G2"\ntags: [meeting]\n---\n# Crlf\n\nG2SUMMARY Crlf\n\n## Transcript\n\n- secret line\n'.replace(/\n/g, "\r\n");
    await writeFile(join(dir, "2026-11-30 10-00 Crlf.md"), crlf);
    const recall = await recentMeetings(dir);
    expect(recall).toContain("G2SUMMARY Crlf");
    expect(recall).not.toContain("source:");
    expect(recall).not.toContain("secret line");
    expect(recall).not.toContain("\r");
  });

  it("keeps older notes when one note is over the budget", async () => {
    const dir = await tempDir();
    await g2Note(dir, 1, "Small old");
    await writeFile(join(dir, "2026-11-29 10-00 Huge.md"), `---\nsource: "Even G2"\n---\n${"y".repeat(20_000)}\n`);
    const recall = await recentMeetings(dir);
    expect(recall).toContain("G2SUMMARY Small old");
    expect(recall).not.toContain("yyyy");
  });
});
