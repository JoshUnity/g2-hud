import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LINKS, MAX_NODES, buildGraph, nodeTitle } from "../server/graph";
import { log } from "../server/log";
import { renderDraftHeader, renderNote } from "../server/notes";
import {
  HEAD_BYTES,
  Vault,
  excluded,
  keepLine,
  parseFrontmatter,
  parseNote,
  recallOff,
  vaultConfig,
  type BlockedNote,
  type VaultConfig,
  type VaultNote,
} from "../server/vault";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const MARK = "ZEBULON";
const KINDS = { people: ["People"], meetings: "Meetings" };

function config(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    root: FIXTURE,
    folders: ["People", "Projects", "Daily", "Meetings"],
    exclude: [],
    people: ["People"],
    meetings: "Meetings",
    self: ["josh"],
    cue: true,
    ...overrides,
  };
}

/** JSON of anything, with Maps as arrays, for leak checks. */
const dump = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? [...v] : v));

async function tmpVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "g2vault-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

async function fixtureNote(path: string): Promise<VaultNote | BlockedNote | null> {
  return parseNote(path, await readFile(join(FIXTURE, path), "utf8"), 0, KINDS);
}

async function scan(cfg: VaultConfig, options?: ConstructorParameters<typeof Vault>[1]): Promise<Vault> {
  const vault = new Vault(cfg, options);
  await vault.refresh(true);
  return vault;
}

const PEOPLE = ["Mark Olsen", "Priya Raman", "Robert Lane", "Sarah Chen", "Tom Baker", "Tom Hale", "Will Turner"].map((n) => "People/" + n + ".md");
const PROJECTS = ["Atlas migration", "Billing revamp", "Harbor launch", "Health", "Ideas", "broken"].map((n) => "Projects/" + n + ".md");
const MEETINGS = [
  "Meetings/2026-09-01 09-00 Lunch with Dana.md",
  "Meetings/2026-10-03 10-00 Atlas migration kickoff.md",
  "Meetings/2026-11-12 14-05 Pricing plan with Sarah.md",
];
const SEVENTEEN = [...PEOPLE, ...PROJECTS, "Daily/2026-11-20.md", ...MEETINGS].sort();

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("vaultConfig", () => {
  const base = { OBSIDIAN_VAULT: "/vault", RECALL_FOLDERS: "People", HUD_USER_NAME: "Josh" };

  it("is off unless the vault, the folders and the wearer's name are set", () => {
    expect(vaultConfig({})).toBeNull();
    expect(vaultConfig({ OBSIDIAN_VAULT: "/vault" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(vaultConfig({ RECALL_FOLDERS: "People" })).toBeNull();
    expect(vaultConfig({ ...base, RECALL_FOLDERS: " , " })).toBeNull();
    warn.mockClear();
    expect(vaultConfig({ OBSIDIAN_VAULT: "/vault", RECALL_FOLDERS: "People" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("RECALL_FOLDERS needs HUD_USER_NAME");
  });

  it("keeps only safe vault-relative folders, in order", () => {
    const cfg = vaultConfig({ ...base, RECALL_FOLDERS: "People, Projects/,/etc, ../x, .obsidian, Meetings" });
    expect(cfg?.folders).toEqual(["People", "Projects", "Meetings"]);
    expect(vaultConfig({ ...base, RECALL_FOLDERS: "." })?.folders).toEqual([""]);
    expect(vaultConfig({ ...base, RECALL_FOLDERS: "./" })?.folders).toEqual([""]);
    expect(vaultConfig({ ...base, RECALL_CUE: "off" })?.cue).toBe(false);
    expect(cfg?.cue).toBe(true);
    expect(cfg?.self).toEqual(["josh"]);
    expect(cfg?.people).toEqual(["People"]);
    expect(cfg?.meetings).toBe("Meetings");
    expect(cfg?.root).toBe("/vault");
  });

  it("makes exclude entries vault-relative and warns about one that cannot match", () => {
    warn.mockClear();
    const cfg = vaultConfig({ ...base, RECALL_EXCLUDE: "./Private, /vault/Archive/Old, /elsewhere/x, ../y, Journal, Secret/*, Work/Old/**, *.tmp" });
    expect(cfg?.exclude).toEqual(["Private", "Archive/Old", "Journal", "Secret", "Work/Old"]);
    expect(excluded("Private/Diary.md", cfg?.exclude ?? [])).toBe(true);
    expect(excluded("Archive/Old/a.md", cfg?.exclude ?? [])).toBe(true);
    expect(excluded("Secret/x.md", cfg?.exclude ?? [])).toBe(true);
    expect(excluded("Work/Old/a/b.md", cfg?.exclude ?? [])).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith("RECALL_EXCLUDE entry cannot match", { entry: "*.tmp" });
    expect(warn).toHaveBeenCalledWith("RECALL_EXCLUDE entry cannot match", { entry: "/elsewhere/x" });
    expect(warn).toHaveBeenCalledWith("RECALL_EXCLUDE entry cannot match", { entry: "../y" });
  });
});

describe("excluded", () => {
  it("matches folder names at any depth and path prefixes", () => {
    expect(excluded("Private/Diary.md", ["private"])).toBe(true);
    expect(excluded("Private/Diary.md", ["Private/"])).toBe(true);
    expect(excluded("People/Family/Mum.md", ["People/Family"])).toBe(true);
    expect(excluded("People/Familyish.md", ["People/Family"])).toBe(false);
    expect(excluded("Work/Old/Private/x.md", ["Private"])).toBe(true);
    expect(excluded("People/Sarah Chen.md", ["Private"])).toBe(false);
  });

  it("compares after NFC and lower case", () => {
    expect(excluded("Prive\u{301}/x.md", ["Priv\u{e9}"])).toBe(true);
  });
});

describe("parseFrontmatter", () => {
  it("reads the list forms, scalars and links", () => {
    const { meta, body } = parseFrontmatter(
      [
        "---",
        'people: ["Sarah", "Josh"]',
        "topics: [pricing, lunch]",
        "aliases: Sara, S. Chen",
        "role: Head of procurement",
        "tags:",
        "  - person",
        '  - "#vip"',
        'link: "[[Sarah Chen|S]]"',
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(meta.people).toEqual(["Sarah", "Josh"]);
    expect(meta.topics).toEqual(["pricing", "lunch"]);
    expect(meta.aliases).toEqual(["Sara", "S. Chen"]);
    expect(meta.role).toEqual(["Head of procurement"]);
    expect(meta.tags).toEqual(["person", "vip"]);
    expect(meta.link).toEqual(["Sarah Chen"]);
    expect(body).toBe("Body.");
  });

  it("handles a BOM and CRLF", () => {
    const { meta, body } = parseFrontmatter("\u{FEFF}---\r\naliases: [Bobby]\r\n---\r\nLawyer at Kite.\r\n");
    expect(meta.aliases).toEqual(["Bobby"]);
    expect(body).toBe("Lawyer at Kite.\n");
  });

  it("drops an unclosed block up to the first blank line", () => {
    const { meta, body } = parseFrontmatter("---\nemail: x\nrole: y\n\nUnclosed frontmatter body.\n");
    expect(meta).toEqual({});
    expect(body).toBe("Unclosed frontmatter body.\n");
  });
});

describe("keepLine", () => {
  it("drops fields, emails, phone numbers and secrets", () => {
    for (const line of [
      "Email: a@b.co",
      "phone:: 123",
      "Birthday: 1 May",
      "Call +44 20 7946 0958",
      "mail sarah@northwind.com",
      "password: x",
      "(555) 123-4567 is her cell",
      "Call me on (020) 7946 0958",
      "+7 495 123-45-67",
      "Sarah's birthday: 1 May 1980",
    ]) {
      expect(keepLine(line), line).toBe(false);
    }
  });

  it("keeps prose, dates and allowlisted fields", () => {
    for (const line of ["Meeting 2026-11-12 14-05 went well", "Role: CTO", "Prefers email over calls.", "Standup 09:30-10:00 on 2026-11-12."]) {
      expect(keepLine(line), line).toBe(true);
    }
  });
});

describe("parseNote", () => {
  it("keeps only the safe extracts of a person note", async () => {
    const sarah = (await fixtureNote("People/Sarah Chen.md")) as VaultNote;
    expect(sarah.kind).toBe("person");
    expect(sarah.lead).toBe("Head of procurement, Northwind. Prefers email over calls. Met at SaaStr.");
    expect(sarah.aliases).toEqual(["Sara", "S. Chen"]);
    expect(sarah.paras).toEqual(["The renewal is due in March and she wants annual billing."]);
    expect(sarah.tasks).toEqual(["Ask about the reseller contract"]);
    const json = JSON.stringify(sarah);
    expect(json).not.toContain(MARK);
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");

    const will = (await fixtureNote("People/Will Turner.md")) as VaultNote;
    expect(will.lead).toBe("Investor at Kite.");
    expect(JSON.stringify(will)).not.toContain(MARK);

    const broken = (await fixtureNote("Projects/broken.md")) as VaultNote;
    expect(broken.lead).toBe("Unclosed frontmatter body.");
    expect(JSON.stringify(broken)).not.toContain(MARK);
  });

  it("reads a meeting note as the app writes it, without transcript or answers", () => {
    const at = new Date(2026, 10, 12, 14, 5);
    const markdown = renderNote(
      "Pricing plan with Sarah",
      {
        title: "Pricing plan with Sarah",
        summary: "Sarah and I went over pricing.",
        decisions: ["Keep the free tier", "Annual discount stays at 15%"],
        action_items: [
          { owner: "Me", task: "Send the deck" },
          { owner: "Sarah", task: "Send usage numbers" },
        ],
        people: ["Sarah", "Josh"],
        topics: ["pricing"],
      },
      [{ at, speaker: "other", text: "ZEBULON transcript line" }],
      [{ at, question: "ZEBULON question", answer: "ZEBULON answer" }],
    );
    const note = parseNote("Meetings/2026-11-12 14-05 Pricing plan with Sarah.md", markdown, 0, KINDS) as VaultNote;
    expect(note.kind).toBe("meeting");
    expect(note.people).toEqual(["Sarah", "Josh"]);
    expect(note.topics).toEqual(["pricing"]);
    expect(note.date).toBe(new Date(2026, 10, 12, 14, 5).getTime());
    expect(note.lead).toBe("Sarah and I went over pricing.");
    expect(note.decisions).toEqual(["Keep the free tier", "Annual discount stays at 15%"]);
    expect(note.tasks).toEqual(["Me: Send the deck", "Sarah: Send usage numbers"]);
    expect(JSON.stringify(note)).not.toContain(MARK);
  });

  it("filters the flattened text of open tasks; only a meeting action item keeps its owner", () => {
    const tasks = ["- [ ] **Birthday:** 1 May 1980", "- [ ] __Home address:__ 12 Elm St", "- [ ] **Me:** Send the deck", "- [ ] Call back"].join("\n");
    expect((parseNote("People/Zed Ray.md", tasks + "\n", 0, KINDS) as VaultNote).tasks).toEqual(["Call back"]);
    expect((parseNote("Daily/2026-11-21.md", tasks + "\n", 0, KINDS) as VaultNote).tasks).toEqual(["Call back"]);
    const meeting = parseNote("Meetings/2026-11-21 10-00 Sync.md", "## Action items\n\n" + tasks + "\n", 0, KINDS) as VaultNote;
    expect(meeting.tasks).toContain("Me: Send the deck");
    expect(meeting.tasks).not.toContain("Home address: 12 Elm St");
  });

  it("reads a BOM + CRLF meeting note and drops an unclosed meeting frontmatter", () => {
    const markdown = renderNote(
      "Pricing plan with Sarah",
      {
        title: "Pricing plan with Sarah",
        summary: "Sarah and I went over pricing.",
        decisions: ["Keep the free tier"],
        action_items: [
          { owner: "Me", task: "Send the deck" },
          { owner: "Sarah", task: "Send usage numbers" },
        ],
        people: ["Sarah"],
        topics: ["pricing"],
      },
      [{ at: new Date(2026, 10, 12, 14, 5), speaker: "other", text: "ZEBULON transcript line" }],
      [],
    );
    const crlf = parseNote("Meetings/2026-11-12 14-05 Pricing plan with Sarah.md", "\u{FEFF}" + markdown.replace(/\n/g, "\r\n"), 0, KINDS) as VaultNote;
    expect(crlf.lead).toBe("Sarah and I went over pricing.");
    expect(crlf.decisions).toEqual(["Keep the free tier"]);
    expect(crlf.tasks).toEqual(["Me: Send the deck", "Sarah: Send usage numbers"]);
    expect(JSON.stringify(crlf)).not.toContain(MARK);

    const unclosed = parseNote("Meetings/2026-11-13 10-00 Sync.md", "---\ntitle: Sync\n- [ ] ZEBULON fm task\n\n## Action items\n\n- [ ] Real task\n", 0, KINDS) as VaultNote;
    expect(unclosed.tasks).toEqual(["Real task"]);
    expect(JSON.stringify(unclosed)).not.toContain(MARK);
  });

  it("blocks recall: false with a trailing YAML comment", () => {
    for (const line of [
      "recall: false # keep out",
      "Recall: FALSE",
      "recall: False # c",
      'recall: "false" # x',
      "recall: 'false' # private",
      "recall: [false] # x",
      '"recall": false',
      "recall:\n  - false",
      "RECALL: false",
      "recall : false",
      "  recall: false",
      "'recall': 'FALSE'",
      "recall: [ 'false' ]",
      "recall: # private\n  - false",
      "recall:\n  - 'false' # x",
      "recall: false\nrecall: true",
      "recall:\n\n  - false",
      "recall:\n  # private\n  - false",
      "recall:\n  false",
      "recall: [\n  false\n]",
      "recall: !!bool false",
    ]) {
      const note = parseNote("People/Zed Ray.md", `---\n${line}\n---\nZEBULON private.\n`, 0, KINDS);
      expect(note, line).toEqual({ blocked: true, path: "People/Zed Ray.md", kind: "person", names: ["Zed Ray", "Zed"] });
    }
    // An unclosed block is no frontmatter, but its recall: false still blocks the note.
    const unclosed = parseNote("People/Zed Ray.md", "---\nrecall: false\n\nZEBULON private.\n", 0, KINDS);
    expect(unclosed).toEqual({ blocked: true, path: "People/Zed Ray.md", kind: "person", names: ["Zed Ray", "Zed"] });
  });

  it("does not block a note for other recall values or for recall: false in the body", () => {
    for (const front of ["recall: true", "recall: falsehood", "recalled: false", "no_recall: false", "notes: recall: false", ""]) {
      expect(recallOff(front), front).toBe(false);
    }
    const body = parseNote("People/Zed Ray.md", "---\nrole: CTO\n---\nLead.\n\nrecall: false\n", 0, KINDS) as VaultNote;
    expect(body.lead).toBe("CTO. Lead.");
  });

  it("drops a fenced code block inside a blockquote, a callout or a list item", () => {
    for (const fence of ["```", "~~~", "````"]) {
      const body = `Lead.\n\n> [!note]\n> ${fence}js\n> ZEBULON in quoted code\n> ${fence}\n\n>${fence}\n>ZEBULON tight quote\n>${fence}\n\n- ${fence}\n  ZEBULON in list code\n  ${fence}\n\n> 1. ${fence}\n>    ZEBULON in quoted list code\n>    ${fence}\n\n- > ${fence}\n  > ZEBULON in list quote code\n  > ${fence}\n\n- - ${fence}\n    ZEBULON in nested list code\n    ${fence}\n\nAfter the code.\n`;
      const note = parseNote("Projects/Code.md", body, 0, KINDS) as VaultNote;
      expect(note.lead, fence).toBe("Lead.");
      expect(note.paras, fence).toEqual(["After the code."]);
      expect(JSON.stringify(note)).not.toContain(MARK);
    }
  });

  it("drops fields whose key is in italics or bold italics", () => {
    const text = [
      "Lead.",
      "",
      "*Birthday*: ZEBULON 1 May 1980",
      "",
      "***Home address:*** ZEBULON 12 Elm St",
      "",
      "- *Partner*: ZEBULON Alex",
      "- [ ] *Bank*: ZEBULON Barclays",
      "- [ ] Call back",
    ].join("\n");
    for (const path of ["People/Zed Ray.md", "Daily/2026-11-21.md", "Meetings/2026-11-21 10-00 Sync.md"]) {
      const note = parseNote(path, text + "\n", 0, KINDS) as VaultNote;
      expect(note.tasks, path).toEqual(["Call back"]);
      expect(JSON.stringify(note), path).not.toContain(MARK);
    }
  });

  it("keeps a plain fence open past quoted or list fence lines inside it", () => {
    for (const fence of ["```", "~~~", "````"]) {
      for (const inner of [`> ${fence}`, `- ${fence}`, `1. ${fence}`, "> ```", "- ```", "1. ~~~"]) {
        const body = `Lead.\n\n${fence}md\n${inner}\nZEBULON in code\n${fence}\n\nAfter the code.\n`;
        const note = parseNote("Projects/Topic note.md", body, 0, KINDS) as VaultNote;
        expect(note.lead, inner).toBe("Lead.");
        expect(note.paras, `${fence} around ${inner}`).toEqual(["After the code."]);
        expect(JSON.stringify(note), inner).not.toContain(MARK);
      }
    }
  });

  it("keeps a quoted or list fence open past fence lines of a deeper container or a deep indent", () => {
    const F = "```";
    for (const code of [
      `- ${F}md\n  > ${F}\n  ZEBULON a\n  ${F}`,
      `> ${F}md\n> > ${F}\n> ZEBULON b\n> ${F}`,
      `> ${F}md\n> - ${F}\n> ZEBULON c\n> ${F}`,
      `> [!note]\n> ${F}md\n> > ${F}\n> > ZEBULON d\n> ${F}`,
      `1. ${F}md\n   - ${F}\n   ZEBULON e\n   ${F}`,
      `${F}\n    ${F}\nZEBULON f\n${F}`,
    ]) {
      const note = parseNote("Projects/Topic note.md", `Lead.\n\n${code}\n\nAfter the code.\n`, 0, KINDS) as VaultNote;
      expect(note.lead, code).toBe("Lead.");
      expect(note.paras, code).toEqual(["After the code."]);
      expect(JSON.stringify(note), code).not.toContain(MARK);
    }
  });

  it("ends a quoted or list fence with its container, so the next fence line opens a new fence", () => {
    const F = "```";
    for (const code of [
      `> ${F}\n> q\n${F}\nZEBULON a\n${F}`,
      `>> ${F}\n>> q\n> ${F}\n> ZEBULON b\n> ${F}`,
      `- ${F}\n  q\n${F}\nZEBULON c\n${F}`,
      `> ${F}\n> q\n\n> ${F}\n> ZEBULON d\n> ${F}`,
    ]) {
      const note = parseNote("Projects/Topic note.md", `Lead.\n\n${code}\n\nAfter the code.\n`, 0, KINDS) as VaultNote;
      expect(note.lead, code).toBe("Lead.");
      expect(note.paras, code).toEqual(["After the code."]);
      expect(JSON.stringify(note), code).not.toContain(MARK);
    }
  });

  it("measures fence columns with tab stops, so tab-indented list code stays code", () => {
    const F = "```";
    for (const code of [
      `- ${F}js\n\tZEBULON a\n\t${F}`,
      `-\t${F}js\n\tZEBULON b\n\t${F}`,
      `>\t${F}\n>\tZEBULON c\n>\t${F}`,
      `${F}\n\t${F}\nZEBULON d\n${F}`,
    ]) {
      const note = parseNote("Projects/Topic note.md", `Lead.\n\n${code}\n\nAfter the code.\n`, 0, KINDS) as VaultNote;
      expect(note.paras, code).toEqual(["After the code."]);
      expect(JSON.stringify(note), code).not.toContain(MARK);
    }
  });

  it("reads triple-backtick inline code as text, not as a fence opener", () => {
    const F = "```";
    for (const inline of [`${F}npm i${F}`, `${F}a\`b${F} run this`]) {
      const body = `Lead.\n\n${inline}\n\nMiddle para.\n\n${F}\nZEBULON secret\n${F}\n\nAfter the code.\n`;
      const note = parseNote("Projects/Topic note.md", body, 0, KINDS) as VaultNote;
      expect(note.paras, inline).toContain("Middle para.");
      expect(note.paras, inline).toContain("After the code.");
      expect(JSON.stringify(note), inline).not.toContain(MARK);
    }
    // A tilde fence may hold a tilde in its info string.
    const tilde = parseNote("Projects/Topic note.md", "Lead.\n\n~~~a~~~\nZEBULON\n~~~\n\nAfter the code.\n", 0, KINDS) as VaultNote;
    expect(tilde.paras).toEqual(["After the code."]);
  });

  it("keeps a leading rule of a meeting body: only the frontmatter is cut", () => {
    const text = "---\ntags: [meeting]\n---\n---\n## Summary\n\nRULE-A summary.\n\n---\n\n## Decisions\n\n- RULE-B decision\n";
    const note = parseNote("Meetings/2026-11-21 10-00 Sync.md", text, 0, KINDS) as VaultNote;
    expect(note.lead).toBe("RULE-A summary.");
    expect(note.decisions).toEqual(["RULE-B decision"]);
  });

  it("drops a long fenced code block that holds a shorter fence line", () => {
    for (const fence of ["````", "~~~~"]) {
      const inner = fence.slice(0, 3);
      const body = `Lead.\n\n${fence}\n${inner}\nZEBULON in code\n${fence}x\n${fence}\n\nAfter the code.\n`;
      const note = parseNote("Projects/Code.md", body, 0, KINDS) as VaultNote;
      expect(note.lead, fence).toBe("Lead.");
      expect(note.paras, fence).toEqual(["After the code."]);
      expect(JSON.stringify(note)).not.toContain(MARK);
    }
  });

  it("skips drafts, blocks recall: false notes and reads BOM + CRLF", async () => {
    expect(parseNote("Meetings/2026-11-25 09-00 Conversation.md", renderDraftHeader(new Date()), 0, KINDS)).toBeNull();
    const secret = await fixtureNote("People/Secret Person.md");
    expect(secret).toEqual({ blocked: true, path: "People/Secret Person.md", kind: "person", names: ["Secret Person", "Secret"] });
    expect(JSON.stringify(secret)).not.toContain(MARK);
    const robert = (await fixtureNote("People/Robert Lane.md")) as VaultNote;
    expect(robert.lead).toBe("Lawyer at Kite.");
    expect(robert.aliases).toEqual(["Bobby"]);
  });

  it("keeps no daily-note prose, only its open tasks", async () => {
    const daily = (await fixtureNote("Daily/2026-11-20.md")) as VaultNote;
    expect(daily.kind).toBe("daily");
    expect(daily.lead).toBe("");
    expect(daily.tasks).toEqual(["Ask Sarah for the usage numbers", "Buy milk"]);
    expect(daily.date).toBe(new Date(2026, 10, 20).getTime());
    expect(JSON.stringify(daily)).not.toContain(MARK);
  });
});

describe("Vault scan", () => {
  it("reads only the listed, non-excluded folders", async () => {
    for (const exclude of [["private"], ["Private/"]]) {
      const vault = await scan(config({ folders: ["People", "Projects", "Daily", "Meetings", "Private"], exclude }));
      expect(vault.notes.map((n) => n.path).sort()).toEqual(SEVENTEEN);
      expect(vault.blocked.map((n) => n.path)).toEqual(["People/Secret Person.md"]);
      expect(dump(vault.notes)).not.toContain(MARK);
      expect(dump(vault.blocked)).not.toContain(MARK);
      expect(dump(vault.index)).not.toContain(MARK);
    }
  });

  it("reads the whole vault with '.', but never hidden folders", async () => {
    const vault = await scan(config({ folders: [""] }));
    const paths = vault.notes.map((n) => n.path).sort();
    expect(paths).toEqual([...SEVENTEEN, "Journal/Secret.md", "Private/Diary.md"].sort());
    expect(paths.some((p) => p.split("/").some((part) => part.startsWith(".")))).toBe(false);
  });

  it("never follows symlinks, refuses a symlinked folder and resolves a symlinked root", async () => {
    const dir = await tmpVault();
    const outer = await mkdtemp(join(tmpdir(), "g2vault-link-"));
    try {
      await symlink(join(dir, "Journal", "Secret.md"), join(dir, "People", "Linked.md"));
      await symlink(join(dir, "Journal"), join(dir, "People", "Linked folder"));
      await symlink(join(dir, "Journal"), join(dir, "Linked"));
      const vault = await scan(config({ root: dir }));
      expect(vault.notes.map((n) => n.path).sort()).toEqual(SEVENTEEN);

      const linked = await scan(config({ root: dir, folders: ["Linked"] }));
      expect(linked.notes).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("recall folder skipped"), expect.anything());

      await symlink(dir, join(outer, "vault"));
      const viaLink = await scan(config({ root: join(outer, "vault") }));
      expect(viaLink.notes.map((n) => n.path).sort()).toEqual(SEVENTEEN);
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never reads a note that became a symlink after the listing", async () => {
    const dir = await tmpVault();
    try {
      let swapped = false;
      const vault = await scan(config({ root: dir }), {
        onFile: async (rel) => {
          if (swapped || !rel.startsWith("People/")) return;
          swapped = true;
          await rm(join(dir, "People", "Will Turner.md"));
          await symlink(join(dir, "Journal", "Secret.md"), join(dir, "People", "Will Turner.md"));
        },
      });
      expect(swapped).toBe(true);
      expect(vault.notes.some((n) => n.path === "People/Will Turner.md")).toBe(false);
      expect(dump(vault.notes)).not.toContain(MARK);
      expect(dump(vault.index)).not.toContain(MARK);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("skips an unreadable note and keeps the rest", async () => {
    const dir = await tmpVault();
    try {
      await chmod(join(dir, "People", "Tom Hale.md"), 0o000);
      const vault = await scan(config({ root: dir }));
      const paths = vault.notes.map((n) => n.path);
      expect(paths).not.toContain("People/Tom Hale.md");
      expect(paths).toContain("People/Tom Baker.md");
      expect(vault.stats?.skipped).toBe(1);
    } finally {
      await chmod(join(dir, "People", "Tom Hale.md"), 0o644);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads only the head of a large note, trims a cut character and skips a NUL file", async () => {
    const dir = await tmpVault();
    try {
      const filler = "Filler words for the middle of a long note.\n".repeat(30_000);
      await writeFile(join(dir, "Projects", "Big plan.md"), "- [ ] Head task\n\n" + filler + "- [ ] Tail task\n");
      // The 64 KB cut falls inside the 51st "é" (2 bytes each).
      const prefix = "a".repeat(HEAD_BYTES - 1 - 15 - 101) + "\n" + "- [ ] Cut here ";
      expect(Buffer.byteLength(prefix) % 2).toBe(1);
      await writeFile(join(dir, "Projects", "Cut plan.md"), prefix + "\u{e9}".repeat(200) + "\nMore.\n");
      await writeFile(join(dir, "People", "Nul Person.md"), "Hello\u{0}world\n");
      const vault = await scan(config({ root: dir }));
      const big = vault.notes.find((n) => n.path === "Projects/Big plan.md");
      expect(big?.tasks).toEqual(["Head task"]);
      const cut = vault.notes.find((n) => n.path === "Projects/Cut plan.md");
      expect(cut?.tasks).toEqual(["Cut here " + "\u{e9}".repeat(50)]);
      expect(dump(cut)).not.toContain("\u{FFFD}");
      expect(vault.notes.some((n) => n.path === "People/Nul Person.md")).toBe(false);
      expect(vault.stats?.skipped).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Vault refresh", () => {
  it("throttles, rereads only changed notes and drops deleted ones", async () => {
    const dir = await tmpVault();
    try {
      const vault = new Vault(config({ root: dir }));
      expect(await vault.refresh(true)).toBe(true);
      expect(await vault.refresh()).toBe(false);
      expect(await vault.refresh(true)).toBe(false);
      expect(vault.stats?.read).toBe(0);

      await writeFile(join(dir, "People", "Tom Hale.md"), "Lawyer at Hale and Partners.\n");
      expect(await vault.refresh(true)).toBe(true);
      expect(vault.stats?.read).toBe(1);
      expect(vault.notes.find((n) => n.path === "People/Tom Hale.md")?.lead).toBe("Lawyer at Hale and Partners.");

      await rm(join(dir, "People", "Tom Baker.md"));
      expect(await vault.refresh(true)).toBe(true);
      expect(vault.notes.some((n) => n.path === "People/Tom Baker.md")).toBe(false);
      expect(vault.index?.subjects.has("n:People/Tom Baker.md")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reruns once when a forced refresh comes during a scan", async () => {
    const dir = await tmpVault();
    try {
      let first = true;
      let during: Promise<boolean> | null = null;
      const vault: Vault = new Vault(config({ root: dir }), {
        onFile: async () => {
          if (!first) return;
          first = false;
          await writeFile(join(dir, "People", "Zara Quinn.md"), "Pilot at Kite.\n");
          during = vault.refresh(true);
        },
      });
      const result = await vault.refresh(true);
      expect(await during).toBe(false);
      expect(result).toBe(true);
      expect(vault.index?.subjects.has("n:People/Zara Quinn.md")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the last index when the root goes away, and starts empty without one", async () => {
    const dir = await tmpVault();
    const moved = dir + "-moved";
    try {
      const vault = await scan(config({ root: dir }));
      const subjects = vault.index?.subjects.size;
      await rename(dir, moved);
      expect(await vault.refresh(true)).toBe(false);
      expect(vault.notes).toHaveLength(17);
      expect(vault.index?.subjects.size).toBe(subjects);

      const none = new Vault(config({ root: join(tmpdir(), "g2vault-never-there") }));
      expect(await none.refresh(true)).toBe(false);
      expect(none.index).toBeNull();
    } finally {
      await rm(moved, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps the note count in folder order", async () => {
    const vault = await scan(config({ folders: ["People", "Projects"] }), { maxNotes: 3 });
    expect(vault.notes).toHaveLength(3);
    expect(vault.notes.every((n) => n.path.startsWith("People/"))).toBe(true);
    expect(vault.stats?.capped).toBe(true);
  });
});


describe("vault graph", () => {
  const graphOf = async (cfg: VaultConfig, dir?: string) => {
    const vault = await scan(dir ? { ...cfg, root: dir } : cfg);
    return buildGraph(vault.index!, vault.notes);
  };
  const titles = (g: { nodes: { title: string }[] }) => g.nodes.map((n) => n.title);
  const WHOLE = { folders: [""], exclude: ["Journal", "Private"] };

  it("lists people, then topics, then the newest meetings, with ids that are positions", async () => {
    const g = await graphOf(config());
    expect(g.nodes.map((n) => n.kind)).toEqual([...Array(8).fill("person"), ...Array(3).fill("topic"), ...Array(3).fill("meeting")]);
    expect(titles(g).slice(0, 8)).toEqual(["Dana Scott", "Mark Olsen", "Priya Raman", "Robert Lane", "Sarah Chen", "Tom Baker", "Tom Hale", "Will Turner"]);
    expect(titles(g).slice(8, 11)).toEqual(["Atlas migration", "Billing revamp", "Harbor launch"]);
    // Newest first, without the date stamp. The recording in progress is a meeting note too.
    expect(titles(g).slice(11)).toContain("Pricing plan with Sarah");
    g.nodes.forEach((n, i) => expect(n.id).toBe(i));
  });

  it("leaves out blocked, unlisted, excluded, hidden, conflicted and own notes", async () => {
    const dir = await tmpVault();
    try {
      await writeFile(join(dir, "People", "Josh.md"), "Me.\n");
      await writeFile(join(dir, "Meetings", "2026-11-26 10-00 Hidden call.md"), "---\nrecall: false\ntags: [meeting]\npeople: [Sarah]\n---\n# Hidden call\n");
      const all = [
        ...titles(await graphOf(config(), dir)),
        ...titles(await graphOf(config({ ...WHOLE }), dir)),
        ...titles(await graphOf(config({ ...WHOLE, folders: [""], exclude: [] }), dir)).filter((t) => t.startsWith("Priya") || t.startsWith("Sarah Chen")),
      ];
      const text = all.join("|");
      for (const bad of ["Secret", "Diary", "Journal", "Hidden", "Old Person", "conflict", "Josh", "ZEBULON"]) expect(text).not.toContain(bad);
      // Unlisted and excluded folders: Private/Diary has the alias "Sarah", Journal/Secret names Priya.
      const whole = titles(await graphOf(config({ ...WHOLE }), dir));
      expect(whole).toContain("Sarah Chen");
      expect(whole.filter((t) => t === "Sarah Chen")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is dumb about content: titles and ids only", async () => {
    const g = await graphOf(config());
    expect(dump({ nodes: g.nodes, links: g.links })).not.toContain(MARK);
    expect(Object.keys(g.nodes[0]!).sort()).toEqual(["id", "kind", "title"]);
  });

  it("links real wikilinks and meeting relations, once each, with no self link", async () => {
    const g = await graphOf(config());
    const at = (title: string) => g.nodes.find((n) => n.title === title)!.id;
    const has = (a: string, b: string) => g.links.some(([x, y]) => (x === at(a) && y === at(b)) || (x === at(b) && y === at(a)));
    expect(has("Atlas migration", "Tom Baker")).toBe(true); // [[Tom Baker]] in the Atlas note
    expect(has("Pricing plan with Sarah", "Sarah Chen")).toBe(true); // meeting people
    expect(has("Atlas migration kickoff", "Atlas migration")).toBe(true); // meeting topics
    expect(has("Atlas migration kickoff", "Priya Raman")).toBe(true); // first name, unique
    expect(has("Atlas migration kickoff", "Tom Baker")).toBe(false); // "Tom" is ambiguous
    expect(has("Lunch with Dana", "Dana Scott")).toBe(true);
    expect(new Set(g.links.map((l) => l.join(","))).size).toBe(g.links.length);
    for (const [a, b] of g.links) {
      expect(a).not.toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(g.nodes.length);
    }
  });

  it("drops a meeting title that contains the name of a blocked note, and its own link to that note", async () => {
    const dir = await tmpVault();
    try {
      await writeFile(join(dir, "Meetings", "2026-11-26 10-00 Call with Secret Person.md"), "---\ntags: [meeting]\npeople: [Secret Person, Sarah]\n---\n# Call\n");
      const g = await graphOf(config(), dir);
      expect(titles(g).join("|")).not.toContain("Secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts the notes recall may quote and the people it knows, not the wearer's own note", async () => {
    const g = await graphOf(config());
    expect(g.total).toEqual({ notes: 17, people: 8 });
    expect(Object.keys(g.total).sort()).toEqual(["notes", "people"]);
    const dir = await tmpVault();
    try {
      await writeFile(join(dir, "People", "Josh.md"), "Me.\n");
      const withOwn = await graphOf(config(), dir);
      expect(withOwn.total).toEqual(g.total);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts people beyond the 80 nodes of the graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2vault-"));
    try {
      await mkdir(join(dir, "People"));
      for (let i = 0; i < 90; i++) await writeFile(join(dir, "People", `Person ${String.fromCharCode(97 + (i % 26))}${i}.md`), "Hi.\n");
      const g = await graphOf(config({ folders: ["People"] }), dir);
      expect(g.nodes).toHaveLength(MAX_NODES);
      expect(g.total).toEqual({ notes: 90, people: 90 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is the same graph for the same vault", async () => {
    const a = await graphOf(config());
    const b = await graphOf(config());
    expect(JSON.stringify([a.nodes, a.links])).toBe(JSON.stringify([b.nodes, b.links]));
  });

  it("caps nodes at 80 with people first, links at 240, and titles at 40 characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2vault-"));
    try {
      await mkdir(join(dir, "People"));
      await mkdir(join(dir, "Projects"));
      await mkdir(join(dir, "Meetings"));
      const long = "Alexandria Bartholomew Cunningham Wetherby";
      await writeFile(join(dir, "People", long + ".md"), "Long.\n");
      for (let i = 0; i < 60; i++) {
        const links = Array.from({ length: 12 }, (_, k) => `[[Person ${String.fromCharCode(97 + ((i + k + 1) % 26))}${(i + k + 1) % 60}]]`).join(" ");
        await writeFile(join(dir, "People", `Person ${String.fromCharCode(97 + (i % 26))}${i}.md`), links + "\n");
      }
      for (let i = 0; i < 40; i++) await writeFile(join(dir, "Projects", `Project number ${i}.md`), "Plan.\n");
      for (let i = 0; i < 20; i++) await writeFile(join(dir, "Meetings", `2026-10-${String(i + 1).padStart(2, "0")} 10-00 Sync ${i}.md`), "---\ntags: [meeting]\n---\n# Sync\n");
      const g = await graphOf(config(), dir);
      expect(g.nodes).toHaveLength(MAX_NODES);
      // 61 people, then 19 topics, no meeting.
      expect(g.nodes.filter((n) => n.kind === "person")).toHaveLength(61);
      expect(g.nodes.filter((n) => n.kind === "topic")).toHaveLength(19);
      expect(g.nodes.some((n) => n.kind === "meeting")).toBe(false);
      expect(g.links.length).toBeLessThanOrEqual(MAX_LINKS);
      expect(g.links.length).toBeGreaterThan(100);
      const longNode = g.nodes.find((n) => n.title.startsWith("Alexandria"))!;
      expect(longNode.title.length).toBeLessThanOrEqual(40);
      expect(nodeTitle({ kind: "person", title: long }).length).toBe(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps links at 240 and keeps the links of people and topics before those of meetings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2vault-"));
    try {
      await mkdir(join(dir, "People"));
      await mkdir(join(dir, "Meetings"));
      // 30 people who all link to each other: 435 pairs.
      const names = Array.from({ length: 30 }, (_, i) => `Person ${String.fromCharCode(97 + (i % 26))}${i}`);
      for (const name of names) await writeFile(join(dir, "People", name + ".md"), names.filter((n) => n !== name).map((n) => `[[${n}]]`).join(" ") + "\n");
      await writeFile(join(dir, "Meetings", "2026-10-01 10-00 Sync.md"), `---\ntags: [meeting]\npeople: [${names[0]}]\n---\n# Sync\n`);
      const g = await graphOf(config(), dir);
      expect(g.links).toHaveLength(MAX_LINKS);
      const meeting = g.nodes.find((n) => n.kind === "meeting")!.id;
      expect(g.links.some((l) => l.includes(meeting))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
