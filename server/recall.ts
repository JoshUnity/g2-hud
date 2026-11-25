import { log } from "./log";
import type { BlockedNote, VaultNote } from "./vault";

export const MAX_SUBJECTS = 3, MAX_NOTES = 6, RECALL_CHARS = 1_600, CUE_GAP_MS = 20_000, PERSON_MS = 3_600_000;

export type Subject = {
  id: string;
  kind: "person" | "topic";
  name: string;
  note: VaultNote | null;
  /** How many meeting notes name this subject (`meetings` keeps only the newest 3). */
  met?: number;
  /** Newest first, at most 3. */
  meetings: { note: VaultNote; firstNameOnly: boolean }[];
  /** Newest first, at most 5. */
  tasks: { text: string; from: string; date: number | null }[];
};
export type NameEntry = { id: string | null; rank: number; rule: "any" | "cap" | "capMid" };
/** `notes`: all notes read. `quotable`: those recall may quote (not the wearer's own). */
export type RecallIndex = { subjects: Map<string, Subject>; names: Map<string, NameEntry>; notes: number; quotable: number };
/** The lens card of a person; a part the vault has nothing for is left out. */
export type Card = { lead?: string; met?: number; seen?: string; last?: string; open?: string };
export type Cue = { name: string; facts: string[]; card?: Card };
export type RecallContext = { text: string; paths: string[] };
export const NO_RECALL: RecallContext = { text: "", paths: [] };

const MAX_MEETINGS = 3;
const MAX_SUBJECT_TASKS = 5;
const MAX_NAME_WORDS = 5;
const NAME_CHARS = 60;
const FACT_CHARS = 80;
const RANK_BLOCKED = 4, RANK_TITLE = 3, RANK_ALIAS = 2, RANK_DERIVED = 1;

/** Common words and names that are also words: a name made only of these (or of words under 3 letters) needs a capital and no sentence start. */
const STOP = new Set(
  (
    "the and for you your yours not but are was were have has had with this that these those from they them their then than there " +
    "here what when where which who whom why how all any some one two can could will would should may might must just like about " +
    "into over out off yes yeah okay well now new old good great time day week month year today tomorrow yesterday home work notes " +
    "note ideas idea inbox todo tasks task index readme meeting meetings people person project projects daily journal plan plans " +
    "list lists misc general draft drafts archive template templates untitled thing things stuff call email money team company " +
    "office mark bill rose grace frank jack max ray sue lily june april august art rich hope joy faith dawn summer pat sky drew " +
    "chase dean miles bob will may next step steps review weekly follow read later action actions items item done back check " +
    "points point"
  ).split(" "),
);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Name comparison form: no accents, lower case, no possessive 's, single spaces between letters and digits. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’]s(?![\p{L}\p{N}])/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};
export const stripStamp = (title: string) => title.replace(/^\d{4}-\d{2}-\d{2}(?: \d{2}-\d{2})?\s+/, "") || title;
export const when = (note: VaultNote) => note.date ?? note.mtimeMs;

/** The subjects, their names and what each one links to. Pure; rebuilt after every vault change. */
export function buildIndex(notes: Iterable<VaultNote>, blocked: Iterable<BlockedNote>, self: string[]): RecallIndex {
  const subjects = new Map<string, Subject>();
  const names = new Map<string, NameEntry>();
  const selfNames = new Set<string>();
  for (const name of self) {
    const key = fold(name);
    if (!key) continue;
    selfNames.add(key);
    selfNames.add(firstWord(key));
  }

  /** False when the name cannot be registered (empty, the wearer, too long or too short). */
  const register = (name: string, id: string | null, rank: number): boolean => {
    const key = fold(name);
    if (!key || selfNames.has(key)) return false;
    const words = key.split(" ").length;
    if (words > MAX_NAME_WORDS) return false;
    // A name made only of common or short words ("Next steps", "To do") needs a capital and no sentence start, like one common word.
    const common = (word: string) => STOP.has(word) || letters(word) < 3;
    let rule: NameEntry["rule"] = key.split(" ").every(common) ? "capMid" : "any";
    if (words === 1) {
      if (STOP.has(key)) rule = "capMid";
      else if (letters(key) < 3) return false;
      else rule = "cap";
    }
    const prev = names.get(key);
    if (!prev || rank > prev.rank) names.set(key, { id, rank, rule });
    else if (rank === prev.rank && prev.id !== id) names.set(key, { ...prev, id: null });
    return true;
  };

  // Blocked names first, at the top rank: nothing replaces them, so they never match.
  for (const note of blocked) for (const name of note.names) register(name, null, RANK_BLOCKED);

  const all = [...notes];
  // The wearer's own note: when its title or an alias is the wearer, all its names are the wearer's.
  // Checked against the configured names only, so the result does not depend on the order of the notes.
  const wearer = new Set(selfNames);
  for (const note of all) {
    if (note.kind !== "person" && note.kind !== "note") continue;
    const own = [note.title, ...note.aliases].map(fold).filter(Boolean);
    if (own.some((key) => wearer.has(key))) for (const key of own) selfNames.add(key);
  }
  /** The wearer's own notes: nothing of them is attached to a subject. */
  const ownPaths = new Set<string>();
  for (const note of all) {
    if (note.kind !== "person" && note.kind !== "note") continue;
    const key = fold(note.title);
    if (key && selfNames.has(key)) ownPaths.add(note.path);
    if (!key || selfNames.has(key)) continue;
    if (note.kind === "note" && key.split(" ").length < 2 && note.aliases.length === 0) continue;
    const id = "n:" + note.path;
    subjects.set(id, { id, kind: note.kind === "person" ? "person" : "topic", name: note.title, note, meetings: [], tasks: [] });
    register(note.title, id, RANK_TITLE);
    for (const alias of note.aliases) register(alias, id, RANK_ALIAS);
    // The first name: unique among person notes, or ambiguous (two ids at one rank match nothing).
    if (note.kind === "person" && note.title.trim().split(/\s+/).length >= 2) register(firstWord(note.title), id, RANK_DERIVED);
  }

  const meetings = all.filter((note) => note.kind === "meeting").sort((a, b) => when(b) - when(a));
  for (const meeting of meetings) {
    const attached = new Set<string>();
    const attach = (id: string, firstNameOnly: boolean) => {
      const subject = subjects.get(id);
      if (!subject || attached.has(id)) return;
      attached.add(id);
      subject.met = (subject.met ?? 0) + 1;
      if (subject.meetings.length < MAX_MEETINGS) subject.meetings.push({ note: meeting, firstNameOnly });
    };
    for (const person of meeting.people) {
      const key = fold(person);
      if (!key || selfNames.has(key)) continue;
      const entry = names.get(key);
      if (entry) {
        // Ambiguous or blocked names (id null) are skipped.
        if (entry.id) attach(entry.id, entry.rank === RANK_DERIVED && !key.includes(" ") && subjects.get(entry.id)?.note != null);
        continue;
      }
      const id = "p:" + key;
      if (!register(person, id, RANK_DERIVED)) continue;
      subjects.set(id, { id, kind: "person", name: person.trim().replace(/[<>]/g, ""), note: null, meetings: [], tasks: [] });
      attach(id, false);
    }
    for (const name of [...meeting.topics, ...meeting.links]) {
      const entry = names.get(fold(name));
      if (entry?.id) attach(entry.id, false);
    }
  }

  const index: RecallIndex = { subjects, names, notes: all.length, quotable: all.length - ownPaths.size };
  for (const note of all) {
    if (note.kind === "meeting" || note.tasks.length === 0 || ownPaths.has(note.path)) continue;
    const own = subjects.has("n:" + note.path) ? "n:" + note.path : null;
    for (const text of note.tasks) {
      const ids = new Set(findSubjects(index, text, false));
      if (own) ids.add(own);
      for (const id of ids) subjects.get(id)?.tasks.push({ text, from: note.path, date: note.date });
    }
  }
  for (const subject of subjects.values()) {
    if (subject.tasks.length === 0) continue;
    subject.tasks.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity) || 0);
    subject.tasks.length = Math.min(subject.tasks.length, MAX_SUBJECT_TASKS);
  }
  return index;
}

type Token = { raw: string; key: string; start: boolean };
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    const at = match.index ?? 0;
    const key = fold(match[0]);
    const start = out.length === 0 || /[.!?]/.test(text.slice(last, at));
    last = at + match[0].length;
    if (key) out.push({ raw: match[0], key, start });
  }
  return out;
}

const upper = (s: string) => {
  const c = s.charAt(0);
  return c !== c.toLowerCase();
};

function ruleOk(rule: NameEntry["rule"], token: Token, typed: boolean): boolean {
  if (rule === "any") return true;
  if (rule === "cap") return typed || upper(token.raw);
  return upper(token.raw) && !token.start;
}

/** Ids of the subjects a line names, in order of appearance. The longest name wins. */
export function findSubjects(index: RecallIndex, text: string, typed = false): string[] {
  const tokens = tokenize(text);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let used = 0;
    for (let len = Math.min(MAX_NAME_WORDS, tokens.length - i); len >= 1; len--) {
      let key = tokens[i]?.key ?? "";
      for (let j = 1; j < len; j++) key += " " + (tokens[i + j]?.key ?? "");
      const entry = index.names.get(key);
      const token = tokens[i];
      if (!entry || !token || !ruleOk(entry.rule, token, typed)) continue;
      used = len;
      if (entry.id && !out.includes(entry.id)) out.push(entry.id);
      break;
    }
    i += used || 1;
  }
  return out;
}

/** True when the text contains the name or an alias of a note that is blocked (`recall: false`). Ignores the capital rules: a leak check, so it errs on the side of yes. */
export function namesBlocked(index: RecallIndex, text: string): boolean {
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    let key = "";
    for (let len = 1; len <= Math.min(MAX_NAME_WORDS, tokens.length - i); len++) {
      key += (len > 1 ? " " : "") + (tokens[i + len - 1]?.key ?? "");
      if (index.names.get(key)?.rank === RANK_BLOCKED) return true;
    }
  }
  return false;
}

/** Printable ASCII, Latin letters and a few typographic marks: what the lens font can draw. */
export function sanitize(text: string): string {
  return text.replace(/[^\x20-\x7E\p{Script=Latin}·…“”‘’]/gu, "").trim();
}

export function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

const shortDate = (ms: number, now: Date) => {
  const d = new Date(ms);
  return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
};

/** The two-line lens cue for a person, and the card of the same facts: newest meeting, first open task, first sentence of the note. */
export function cueFor(subject: Subject, now: Date, index?: RecallIndex): Cue | null {
  if (subject.kind !== "person") return null;
  const meeting = subject.meetings[0]?.note;
  const date = meeting ? shortDate(when(meeting), now) : null;
  const last = meeting && date ? date + "  ·  " + stripStamp(meeting.title) : null;
  const task = subject.meetings.flatMap((m) => m.note.tasks)[0] ?? subject.tasks[0]?.text;
  const open = task ? task.replace(/^Me:\s+/, "") : null;
  const lead = subject.note?.lead;
  const sentence = lead ? (/^.*?[.!?](?=\s|$)/.exec(lead)?.[0] ?? lead) : null;
  // A part (a meeting title, a task, a lead) that names a blocked note is left out.
  const clean = (text: string | null, max: number): string | null => {
    if (!text || (index && namesBlocked(index, text))) return null;
    return clamp(sanitize(text), max) || null;
  };
  const name = clamp(sanitize(subject.name), NAME_CHARS);
  const facts = [clean(last, FACT_CHARS), open && clean("Open: " + open, FACT_CHARS), clean(sentence, FACT_CHARS)]
    .filter((fact): fact is string => fact !== null)
    .slice(0, 3);
  if (index && namesBlocked(index, name)) return null;
  if (!name || facts.length === 0) return null;
  const met = subject.met ?? subject.meetings.length;
  const card: Card = {};
  const cardLead = clean(sentence, 80);
  if (cardLead) card.lead = cardLead;
  if (met > 0) card.met = met;
  if (date) card.seen = clamp(date, 12);
  const cardLast = clean(last, 60);
  if (cardLast) card.last = cardLast;
  const cardOpen = clean(open, 60);
  if (cardOpen) card.open = cardOpen;
  return Object.keys(card).length > 0 ? { name, facts, card } : { name, facts };
}

const wordsOf = (text: string) => new Set(fold(text).split(" "));
const overlap = (question: Set<string>, text: string) => {
  let n = 0;
  for (const word of wordsOf(text)) if (question.has(word)) n++;
  return n;
};

type Part = { subject: number; slot: number; lines: string[]; paths: string[]; tasks: string[]; meeting: string | null };
const SLOT_HEADER = 0, SLOT_ALSO = 1, SLOT_MEETING = 2, SLOT_TASKS = 3;

function render(parts: Part[], count: number): string {
  const groups: string[] = [];
  for (let i = 0; i < count; i++) {
    const lines = parts
      .filter((p) => p.subject === i)
      .sort((a, b) => a.slot - b.slot)
      .flatMap((p) => p.lines);
    if (lines.length > 0) groups.push(lines.join("\n"));
  }
  return "<vault_notes>\n" + groups.join("\n") + "\n</vault_notes>";
}

/** The <vault_notes> block for the ranked subjects, within MAX_NOTES files and RECALL_CHARS characters. */
function compose(subjects: Subject[], question: string, skipMeeting?: (title: string) => boolean): RecallContext {
  const asked = new Set(
    fold(question)
      .split(" ")
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
  const accepted: Part[] = [];
  const quotedTasks = new Set<string>();
  const quotedMeetings = new Set<string>();
  const hasHeader = new Set<number>();
  /** Names and titles go into the block as they are: no "<" or ">" may forge a tag. */
  const safe = (s: string) => s.replace(/[<>]/g, "");

  const tryAdd = (part: Part | null): boolean => {
    if (!part) return false;
    const next = [...accepted, part];
    const paths = new Set(next.flatMap((p) => p.paths));
    if (paths.size > MAX_NOTES || render(next, subjects.length).length > RECALL_CHARS) return false;
    accepted.push(part);
    for (const task of part.tasks) quotedTasks.add(task);
    if (part.meeting) quotedMeetings.add(part.meeting);
    return true;
  };

  const header = (i: number, s: Subject): Part => ({
    subject: i,
    slot: SLOT_HEADER,
    lines: ["## " + safe(s.name) + " (" + s.kind + ")", ...(s.note?.lead ? ["Note: " + s.note.lead] : [])],
    paths: s.note ? [s.note.path] : [],
    tasks: [],
    meeting: null,
  });

  const also = (i: number, s: Subject): Part | null => {
    let best: string | null = null;
    let score = 0;
    for (const para of s.note?.paras ?? []) {
      const n = overlap(asked, para);
      if (n > score) {
        best = para;
        score = n;
      }
    }
    if (!best || !s.note) return null;
    return { subject: i, slot: SLOT_ALSO, lines: ["Also: " + best], paths: [s.note.path], tasks: [], meeting: null };
  };

  const meeting = (i: number, s: Subject): Part | null => {
    let pick = 0;
    let score = -1;
    s.meetings.forEach((m, k) => {
      const n = overlap(asked, [m.note.lead, ...m.note.decisions, ...m.note.tasks].join(" "));
      if (n > score) {
        pick = k;
        score = n;
      }
    });
    const chosen = s.meetings[pick];
    if (!chosen) return null;
    const note = chosen.note;
    const label = (pick === 0 ? "Last meeting " : "Meeting ") + isoDay(when(note)) + ' "' + safe(stripStamp(note.title)) + '"';
    const first = chosen.firstNameOnly ? ' (matched by first name "' + safe(firstWord(s.name)) + '" only)' : "";
    const base = { subject: i, slot: SLOT_MEETING, paths: [note.path], meeting: note.path };
    if (quotedMeetings.has(note.path)) return { ...base, lines: [label + " (see above)"], tasks: [] };
    const tasks = note.tasks.slice(0, 3);
    const open = tasks.length > 0 ? ["Open from that meeting (" + isoDay(when(note)) + ", may be done already): " + tasks.join("; ")] : [];
    if (skipMeeting?.(note.title)) return { ...base, lines: [label + " (in the past meeting notes above)" + first, ...open], tasks };
    const decided = note.decisions.length > 0 ? ["Decided: " + note.decisions.slice(0, 3).join("; ")] : [];
    return { ...base, lines: [label + first + (note.lead ? ": " + note.lead : ""), ...decided, ...open], tasks };
  };

  const others = (i: number, s: Subject): Part | null => {
    const tasks = s.tasks.filter((t) => !quotedTasks.has(t.text)).slice(0, 3);
    if (tasks.length === 0) return null;
    const text = tasks.map((t) => t.text + (t.date === null ? "" : " (" + isoDay(t.date) + ")")).join("; ");
    return {
      subject: i,
      slot: SLOT_TASKS,
      lines: ["Other open tasks: " + text],
      paths: [...new Set(tasks.map((t) => t.from))],
      tasks: tasks.map((t) => t.text),
      meeting: null,
    };
  };

  // 1. Every subject's header and lead.
  subjects.forEach((s, i) => {
    if (tryAdd(header(i, s))) hasHeader.add(i);
  });
  const rest = subjects.map((s, i) => ({ s, i })).filter(({ i }) => i > 0 && hasHeader.has(i));
  const first = subjects[0];
  // 2. The first subject's meeting and paragraph.
  if (first && hasHeader.has(0)) {
    tryAdd(meeting(0, first));
    tryAdd(also(0, first));
  }
  // 3. The other subjects' open tasks. 4. The first subject's open tasks.
  for (const { s, i } of rest) tryAdd(others(i, s));
  if (first && hasHeader.has(0)) tryAdd(others(0, first));
  // 5. The other subjects' meetings and paragraphs.
  for (const { s, i } of rest) {
    tryAdd(meeting(i, s));
    tryAdd(also(i, s));
  }
  if (accepted.length === 0) return NO_RECALL;
  return { text: render(accepted, subjects.length), paths: [...new Set(accepted.flatMap((p) => p.paths))] };
}

type Mention = { line: number; at: number; order: number };

/**
 * Per conversation: which subjects were named and when, which cues went out, and the block for a question.
 * observe() and context() never throw and do no I/O.
 */
export class RecallTracker {
  private named = new Map<string, Mention>();
  private cued = new Set<string>();
  /** Sanitised name sent to the lens → subject id, for shown(). */
  private sent = new Map<string, string>();
  private lastCueAt = Number.NEGATIVE_INFINITY;
  private line = 0;
  private order = 0;
  private warned = false;

  constructor(
    private index: () => RecallIndex | null,
    private options: { cue: boolean; topicLines: number; skipMeeting?: (title: string) => boolean },
  ) {}

  /** Records the subjects a line names. Returns a cue when a person should be shown on the lens. */
  observe(text: string, options: { typed?: boolean; now?: number } = {}): Cue | null {
    const now = options.now ?? Date.now();
    try {
      this.line++;
      const index = this.index();
      if (!index) return null;
      const ids = findSubjects(index, text, options.typed ?? false);
      for (const id of ids) this.named.set(id, { line: this.line, at: now, order: this.order++ });
      if (!this.options.cue || now - this.lastCueAt < CUE_GAP_MS) return null;
      for (const id of ids) {
        const subject = index.subjects.get(id);
        if (!subject || subject.kind !== "person" || this.cued.has(id)) continue;
        const cue = cueFor(subject, new Date(now), index);
        if (!cue) continue;
        this.sent.set(cue.name, id);
        this.lastCueAt = now;
        return cue;
      }
      return null;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** The <vault_notes> block for a question that goes to Claude anyway. Empty when nothing is active. */
  context(question: string, options: { now?: number } = {}): RecallContext {
    const now = options.now ?? Date.now();
    try {
      const index = this.index();
      if (!index || this.named.size === 0) return NO_RECALL;
      const active: { subject: Subject; mention: Mention }[] = [];
      for (const [id, mention] of this.named) {
        const subject = index.subjects.get(id);
        const live =
          subject !== undefined &&
          (subject.kind === "person" ? now - mention.at <= PERSON_MS : this.line - mention.line < this.options.topicLines);
        if (live) active.push({ subject, mention });
        else this.named.delete(id);
      }
      active.sort(
        (a, b) =>
          b.mention.line - a.mention.line ||
          Number(b.subject.kind === "person") - Number(a.subject.kind === "person") ||
          a.mention.order - b.mention.order,
      );
      const picked = active.slice(0, MAX_SUBJECTS).map((a) => a.subject);
      if (picked.length === MAX_SUBJECTS && !picked.some((s) => s.kind === "person")) {
        const person = active.find((a) => a.subject.kind === "person");
        if (person) picked[MAX_SUBJECTS - 1] = person.subject;
      }
      if (picked.length === 0) return NO_RECALL;
      return compose(picked, question, this.options.skipMeeting);
    } catch (error) {
      this.fail(error);
      return NO_RECALL;
    }
  }

  /** The subject id of the person whose cue carried this name, or undefined. */
  subjectOf(name: string): string | undefined {
    return this.sent.get(name);
  }

  /** The lens showed the cue for this name: that person is not cued again in this conversation. */
  shown(name: string): void {
    const id = this.sent.get(name);
    if (id) this.cued.add(id);
  }

  /** A new conversation. */
  reset(): void {
    this.named.clear();
    this.cued.clear();
    this.sent.clear();
    this.lastCueAt = Number.NEGATIVE_INFINITY;
    this.line = 0;
  }

  private fail(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    log.warn("vault recall failed; requests go without vault notes", { error: String(error) });
  }
}
