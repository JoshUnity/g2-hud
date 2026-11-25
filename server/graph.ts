import { clamp, fold, namesBlocked, sanitize, stripStamp, when, type RecallIndex } from "./recall";
import type { VaultNote } from "./vault";

export const MAX_NODES = 80, MAX_LINKS = 240, TITLE_CHARS = 40;

export type GraphNode = { id: number; title: string; kind: "person" | "topic" | "meeting" };
export type VaultGraph = {
  nodes: GraphNode[];
  links: [number, number][];
  /** Recall subject id → node id, for `recall.id`. Not sent. */
  ids: Map<string, number>;
  /** Counts only: the notes recall may quote and the people it knows, graph or not. */
  total: { notes: number; people: number };
};

/** The title the glasses see for a note: no date stamp on a meeting, only characters the lens can draw, at most 40. */
export function nodeTitle(note: Pick<VaultNote, "kind" | "title">): string {
  return clamp(sanitize(note.kind === "meeting" ? stripStamp(note.title) : note.title), TITLE_CHARS);
}

const num = (a: number, b: number) => a - b;

/**
 * The vault as titles and links, from the recall index: people, then topics, then the newest meetings, up to 80.
 * Only what recall may already quote: the index holds no blocked, excluded, hidden or own note. A title that
 * contains the name of a blocked note, or a subject that its own name does not reach, is left out too.
 * Pure and ordered, so one vault gives one graph.
 */
export function buildGraph(index: RecallIndex, notes: Iterable<VaultNote>): VaultGraph {
  const nodes: GraphNode[] = [];
  const ids = new Map<string, number>();
  const byTitle = new Map<string, number>();
  const safe = (title: string) => title !== "" && !namesBlocked(index, title);
  const add = (kind: GraphNode["kind"], title: string): number => {
    nodes.push({ id: nodes.length, title, kind });
    return nodes.length - 1;
  };

  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
    fold(a.name).localeCompare(fold(b.name)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const subjects = [...index.subjects.values()].filter((s) => index.names.get(fold(s.name))?.id === s.id);
  for (const kind of ["person", "topic"] as const) {
    for (const subject of subjects.filter((s) => s.kind === kind).sort(byName)) {
      if (nodes.length >= MAX_NODES) break;
      const title = subject.note ? nodeTitle(subject.note) : clamp(sanitize(subject.name), TITLE_CHARS);
      if (safe(title)) ids.set(subject.id, add(kind, title));
    }
  }

  const meetingNodes: { note: VaultNote; node: number }[] = [];
  const meetings = [...notes]
    .filter((n) => n.kind === "meeting")
    .sort((a, b) => when(b) - when(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const note of meetings) {
    if (nodes.length >= MAX_NODES) break;
    const title = nodeTitle(note);
    if (!safe(title)) continue;
    const node = add("meeting", title);
    meetingNodes.push({ note, node });
    byTitle.set(fold(stripStamp(note.title)), node);
    byTitle.set(fold(note.title), node);
  }

  const resolve = (name: string): number | undefined => {
    const key = fold(name);
    const id = index.names.get(key)?.id;
    return (id ? ids.get(id) : undefined) ?? byTitle.get(key);
  };
  const people = new Set<string>();
  const meeting = new Set<string>();
  const pair = (into: Set<string>, a: number, b: number | undefined) => {
    if (b !== undefined && a !== b) into.add(Math.min(a, b) + "," + Math.max(a, b));
  };
  for (const subject of subjects) {
    const from = ids.get(subject.id);
    if (from === undefined || !subject.note) continue;
    for (const link of subject.note.links) pair(people, from, resolve(link));
  }
  for (const { note, node } of meetingNodes) {
    for (const name of [...note.people, ...note.topics, ...note.links]) pair(meeting, node, resolve(name));
  }
  const order = (set: Set<string>) =>
    [...set]
      .map((s) => s.split(",").map(Number) as [number, number])
      .sort((a, b) => num(a[0], b[0]) || num(a[1], b[1]));
  const links: [number, number][] = [];
  const seen = new Set<string>();
  for (const [a, b] of [...order(people), ...order(meeting)]) {
    if (links.length >= MAX_LINKS) break;
    if (seen.has(a + "," + b)) continue;
    seen.add(a + "," + b);
    links.push([a, b]);
  }
  return { nodes, links, ids, total: { notes: index.quotable, people: subjects.filter((s) => s.kind === "person").length } };
}
