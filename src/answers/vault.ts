import { layoutGraph, type Graph3 } from "../core/three";

/** The vault as the glasses draw it: titles, links by node index, and a 3D layout made once per message. */
export type VaultNode = { id: number; title: string; kind: "person" | "topic" | "meeting" };
/** `total`: how many notes and people the whole vault holds (the graph shows only some), when the server says. */
export type VaultTotal = { notes: number; people: number };
export type Vault = { nodes: VaultNode[]; graph: Graph3; people: number; total: VaultTotal | null };

export type VaultMessage = { nodes: VaultNode[]; links: [number, number][]; total?: VaultTotal };

/** Lays the graph out once. Links name node ids; a link to an unknown id is dropped. */
export function buildVault(message: VaultMessage): Vault {
  const index = new Map(message.nodes.map((node, i) => [node.id, i]));
  const links: [number, number][] = [];
  for (const [a, b] of message.links) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined && i !== j) links.push([i, j]);
  }
  return {
    nodes: message.nodes,
    graph: { points: layoutGraph(message.nodes.length, links), links },
    people: message.nodes.filter((n) => n.kind === "person").length,
    total: message.total ?? null,
  };
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The node of a person: by id when the cue has one, else the node whose title is the name. */
export function findNode(vault: Vault, name: string, id?: number): number | null {
  if (id !== undefined) {
    const byId = vault.nodes.findIndex((n) => n.id === id);
    if (byId >= 0) return byId;
  }
  const byTitle = vault.nodes.findIndex((n) => same(n.title, name));
  return byTitle >= 0 ? byTitle : null;
}

/** Up to `max` nodes linked to `node`, in link order. */
export function linkedNodes(vault: Vault, node: number, max: number): number[] {
  const out: number[] = [];
  for (const [a, b] of vault.graph.links) {
    const other = a === node ? b : b === node ? a : -1;
    if (other >= 0 && !out.includes(other)) out.push(other);
    if (out.length === max) break;
  }
  return out;
}

/** The nodes whose titles are in `titles`. */
export function sourceNodes(vault: Vault, titles: string[]): number[] {
  const out: number[] = [];
  for (const title of titles) {
    const i = vault.nodes.findIndex((n) => same(n.title, title));
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out;
}
