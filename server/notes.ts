import type { Speaker } from "../src/core/protocol";

export type NoteLine = { at: Date; speaker: Speaker; text: string };
export type NoteAnswer = { at: Date; question: string; answer: string };
export type MeetingSummary = {
  title: string;
  summary: string;
  decisions: string[];
  action_items: { owner: string; task: string }[];
  people: string[];
  topics: string[];
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-23 14-05" in local time, for file names. */
export function fileStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
}

/** "14:05:12" in local time. */
export function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Removes characters that file systems or Obsidian links do not allow. */
export function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || "Conversation";
}

export function speakerLabel(speaker: Speaker): string {
  if (speaker === "self") return "Me";
  if (speaker === "other") return "Them";
  return "Speaker";
}

export function renderLine(line: NoteLine): string {
  return `- ${clock(line.at)} **${speakerLabel(line.speaker)}:** ${line.text}`;
}

const yamlList = (items: string[]) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;

/** The note while the conversation is still going: transcript only, appended live. */
export function renderDraftHeader(startedAt: Date): string {
  return [
    "---",
    'source: "Even G2"',
    `started: "${startedAt.toISOString()}"`,
    "status: recording",
    "tags: [meeting]",
    "---",
    "# Conversation (recording)",
    "",
    "## Transcript",
    "",
  ].join("\n");
}

/** The finished note: summary first, transcript last. `recalled` lists the vault notes quoted to Claude (vault-relative paths). */
export function renderNote(
  title: string,
  summary: MeetingSummary | null,
  lines: NoteLine[],
  answers: NoteAnswer[],
  recalled: string[] = [],
): string {
  const first = lines[0]?.at ?? new Date();
  const last = lines[lines.length - 1]?.at ?? first;
  const minutes = Math.max(1, Math.round((last.getTime() - first.getTime()) / 60_000));
  const out = [
    "---",
    'source: "Even G2"',
    `started: "${first.toISOString()}"`,
    `ended: "${last.toISOString()}"`,
    `duration_minutes: ${minutes}`,
    `people: ${yamlList(summary?.people ?? [])}`,
    `topics: ${yamlList(summary?.topics ?? [])}`,
    "tags: [meeting]",
    "---",
    `# ${title}`,
    "",
  ];
  if (summary) {
    out.push("## Summary", "", summary.summary, "");
    if (summary.decisions.length > 0) out.push("## Decisions", "", ...summary.decisions.map((d) => `- ${d}`), "");
    if (summary.action_items.length > 0) {
      out.push("## Action items", "", ...summary.action_items.map((a) => `- [ ] **${a.owner}:** ${a.task}`), "");
    }
  } else {
    out.push("_No summary: the summary request failed. The transcript is complete._", "");
  }
  if (answers.length > 0) {
    out.push("## Answers shown on the glasses", "");
    for (const a of answers) out.push(`- ${clock(a.at)} **Q:** ${a.question}`, `  **A:** ${a.answer.replace(/\n+/g, " ")}`);
    out.push("");
  }
  if (recalled.length > 0) {
    out.push("## Vault notes sent to Claude", "", ...recalled.map((path) => `- [[${path.replace(/\.md$/, "")}]]`), "");
  }
  out.push("## Transcript", "", ...lines.map(renderLine), "");
  return out.join("\n");
}

/** Title, summary, decisions and action items of a finished note, for recall in later conversations. */
export function digest(markdown: string): string {
  return digestBody(markdown.replace(/^---[\s\S]*?\n---\n/, ""));
}

/** digest of a body whose frontmatter is already gone: a leading "---" rule is text, not frontmatter. */
export function digestBody(body: string): string {
  const cut = body.search(/^## (Answers shown on the glasses|Vault notes sent to Claude|Transcript)/m);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}
