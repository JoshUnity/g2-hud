import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MeetingRecorder, recentMeetings } from "../server/meetings";
import { digest, renderNote, safeFileName, type MeetingSummary } from "../server/notes";

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "g2hud-"));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const summary: MeetingSummary = {
  title: "Pricing plan with Sarah",
  summary: "Sarah and I went over pricing.",
  decisions: ["Keep the free tier"],
  action_items: [{ owner: "Me", task: "Send the deck" }],
  people: ["Sarah"],
  topics: ["pricing"],
};

describe("notes", () => {
  it("makes safe file names", () => {
    expect(safeFileName('Q3: "plan" / next?')).toBe("Q3 plan next");
    expect(safeFileName("  ")).toBe("Conversation");
  });

  it("renders summary, tasks and transcript", () => {
    const at = new Date(2026, 10, 23, 14, 5, 0);
    const note = renderNote("Pricing plan", summary, [{ at, speaker: "other", text: "What about pricing?" }], []);
    expect(note).toContain('people: ["Sarah"]');
    expect(note).toContain("- [ ] **Me:** Send the deck");
    expect(note).toContain("- 14:05:00 **Them:** What about pricing?");
    expect(digest(note)).not.toContain("Transcript");
    expect(digest(note)).toContain("Keep the free tier");
  });

  it("writes the vault notes sent to Claude before the transcript, and digest leaves them out", () => {
    const at = new Date(2026, 10, 23, 14, 5, 0);
    const lines = [{ at, speaker: "other" as const, text: "What about pricing?" }];
    const answers = [{ at, question: "What about pricing?", answer: "Keep the free tier." }];
    const note = renderNote("Pricing plan", summary, lines, answers, ["Daily/2026-11-20.md", "People/Sarah Chen.md"]);
    const section = "## Vault notes sent to Claude\n\n- [[Daily/2026-11-20]]\n- [[People/Sarah Chen]]\n\n## Transcript\n";
    expect(note).toContain(section);
    expect(note.indexOf("## Answers shown on the glasses")).toBeLessThan(note.indexOf("## Vault notes sent to Claude"));
    // Without answers the section still comes right before the transcript.
    expect(renderNote("Pricing plan", summary, lines, [], ["People/Sarah Chen.md"])).toContain(
      "## Vault notes sent to Claude\n\n- [[People/Sarah Chen]]\n\n## Transcript\n",
    );
    expect(digest(note)).not.toContain("Vault notes");
    expect(digest(note)).not.toContain("Sarah Chen]]");
    expect(digest(renderNote("Pricing plan", summary, lines, [], ["People/Sarah Chen.md"]))).not.toContain("Sarah Chen]]");
  });

  it("renders exactly today's note without recalled notes", () => {
    const first = new Date(2026, 10, 23, 14, 5, 0);
    const last = new Date(2026, 10, 23, 14, 9, 0);
    const lines = [
      { at: first, speaker: "other" as const, text: "What about pricing?" },
      { at: last, speaker: "self" as const, text: "Free tier stays." },
    ];
    const answers = [{ at: first, question: "What about pricing?", answer: "Keep\nthe free tier." }];
    const expected = [
      "---",
      'source: "Even G2"',
      `started: "${first.toISOString()}"`,
      `ended: "${last.toISOString()}"`,
      "duration_minutes: 4",
      'people: ["Sarah"]',
      'topics: ["pricing"]',
      "tags: [meeting]",
      "---",
      "# Pricing plan",
      "",
      "## Summary",
      "",
      "Sarah and I went over pricing.",
      "",
      "## Decisions",
      "",
      "- Keep the free tier",
      "",
      "## Action items",
      "",
      "- [ ] **Me:** Send the deck",
      "",
      "## Answers shown on the glasses",
      "",
      "- 14:05:00 **Q:** What about pricing?",
      "  **A:** Keep the free tier.",
      "",
      "## Transcript",
      "",
      "- 14:05:00 **Them:** What about pricing?",
      "- 14:09:00 **Me:** Free tier stays.",
      "",
    ].join("\n");
    expect(renderNote("Pricing plan", summary, lines, answers)).toBe(expected);
    expect(renderNote("Pricing plan", summary, lines, answers, [])).toBe(expected);
    expect(renderNote("Pricing plan", null, lines, [], [])).toBe(renderNote("Pricing plan", null, lines, []));
    expect(expected).not.toContain("Vault notes");
  });
});

describe("MeetingRecorder", () => {
  it("writes a draft live, then replaces it with the summarized note", async () => {
    const dir = await tempDir();
    const recorder = new MeetingRecorder(dir);
    recorder.add({ at: new Date(2026, 10, 23, 14, 5, 0), speaker: "other", text: "Hello there" });
    recorder.add({ at: new Date(2026, 10, 23, 14, 6, 0), speaker: "self", text: "Hi Sarah" });
    const saved = await recorder.finish(async () => summary);
    expect(saved?.title).toBe("Pricing plan with Sarah");
    const files = await readdir(dir);
    expect(files).toEqual(["2026-11-23 14-05 Pricing plan with Sarah.md"]);
    const text = await readFile(join(dir, files[0] ?? ""), "utf8");
    expect(text).toContain("**Me:** Hi Sarah");
    expect(await recentMeetings(dir)).toContain("Sarah and I went over pricing.");
  });

  it("keeps the transcript when the summary fails", async () => {
    const dir = await tempDir();
    const recorder = new MeetingRecorder(dir);
    recorder.add({ at: new Date(2026, 10, 23, 9, 0, 0), speaker: "other", text: "Quick sync" });
    await recorder.finish(async () => {
      throw new Error("offline");
    });
    const [name] = await readdir(dir);
    expect(name).toBe("2026-11-23 09-00 Conversation.md");
    expect(await readFile(join(dir, name ?? ""), "utf8")).toContain("Quick sync");
  });

  it("does nothing when there was no speech", async () => {
    const dir = await tempDir();
    expect(await new MeetingRecorder(dir).finish(async () => summary)).toBeNull();
  });

  it("lists the recalled vault notes sorted and unique, only while a draft exists", async () => {
    const dir = await tempDir();
    const recorder = new MeetingRecorder(dir);
    // A typed question before any speech: there is no draft yet, so it is not recorded.
    recorder.addRecalled(["Private/Before speech.md"]);
    recorder.add({ at: new Date(2026, 10, 23, 14, 5, 0), speaker: "other", text: "Hi Sarah" });
    recorder.addRecalled(["People/Sarah Chen.md", "Meetings/2026-11-12 14-05 Pricing plan with Sarah.md"]);
    recorder.addRecalled(["People/Sarah Chen.md", "Daily/2026-11-20.md"]);
    await recorder.finish(async () => summary);
    const [name] = await readdir(dir);
    const text = await readFile(join(dir, name ?? ""), "utf8");
    expect(text).toContain(
      [
        "## Vault notes sent to Claude",
        "",
        "- [[Daily/2026-11-20]]",
        "- [[Meetings/2026-11-12 14-05 Pricing plan with Sarah]]",
        "- [[People/Sarah Chen]]",
        "",
        "## Transcript",
      ].join("\n"),
    );
    expect(text).not.toContain("Before speech");

    // The next conversation starts with an empty list.
    recorder.add({ at: new Date(2026, 10, 23, 15, 0, 0), speaker: "other", text: "Next talk" });
    await recorder.finish(async () => ({ ...summary, title: "Next talk" }));
    const next = await readFile(join(dir, "2026-11-23 15-00 Next talk.md"), "utf8");
    expect(next).not.toContain("Vault notes sent to Claude");
    expect(next).not.toContain("Sarah Chen]]");
  });
});

describe("recentMeetings and recall: false", () => {
  it("skips an own note marked recall: false", async () => {
    const dir = await tempDir();
    const at = new Date(2026, 10, 12, 14, 5, 0);
    const lines = [{ at, speaker: "other" as const, text: "Hello" }];
    await writeFile(join(dir, "2026-11-12 14-05 Pricing plan with Sarah.md"), renderNote("Pricing plan with Sarah", summary, lines, []));
    const hidden = renderNote("Private family talk", { ...summary, summary: "HIDDEN-SUMMARY" }, lines, []).replace(
      "tags: [meeting]\n",
      "tags: [meeting]\nrecall: false\n",
    );
    await writeFile(join(dir, "2026-11-13 09-00 Private family talk.md"), hidden);
    const recall = await recentMeetings(dir);
    expect(recall).toContain("### 2026-11-12 14-05 Pricing plan with Sarah\n");
    expect(recall).toContain("Sarah and I went over pricing.");
    expect(recall).not.toContain("HIDDEN-SUMMARY");
    expect(recall).not.toContain("Private family talk");
  });
});
