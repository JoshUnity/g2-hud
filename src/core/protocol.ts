import { z } from "zod";

/** Who spoke, as classified per audio frame by the Even app. */
export const SpeakerSchema = z.enum(["self", "other", "unknown"]);
export type Speaker = z.infer<typeof SpeakerSchema>;

/** Audio frames travel as binary WebSocket messages: one speaker byte, then 16 kHz s16le PCM. */
const SPEAKER_CODES: readonly Speaker[] = ["unknown", "self", "other"];

export function speakerCode(speaker: Speaker): number {
  return SPEAKER_CODES.indexOf(speaker);
}

export function speakerFromCode(code: number | undefined): Speaker {
  return SPEAKER_CODES[code ?? 0] ?? "unknown";
}

const LatLon = z.tuple([z.number(), z.number()]);

/** What the glasses get from Loops: a trimmed, validated subset of the city view. */
export const OsintSchema = z.object({
  connected: z.boolean(),
  error: z.string().nullable(),
  at: z.number(),
  /** Where the aircraft data comes from, when it is not the owner's own receiver: "adsb.fi", "opensky", "airplanes.live". */
  aircraftSource: z.string().min(1).max(24).optional(),
  me: z
    .object({
      lat: z.number(),
      lon: z.number(),
      source: z.enum(["gps", "home", "default"]),
      area: z.string().nullable(),
      heading: z.number().nullable(),
    })
    .nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      severity: z.number().int().min(0).max(3),
      title: z.string(),
      lat: z.number().nullable(),
      lon: z.number().nullable(),
      area: z.string().nullable(),
      lines: z.array(z.array(LatLon)),
    }),
  ),
  aircraft: z.array(
    z.object({
      id: z.string(),
      callsign: z.string().nullable(),
      lat: z.number(),
      lon: z.number(),
      altitude_ft: z.number().nullable(),
      /** Climb rate in feet per minute, positive = climbing. */
      vrate: z.number().nullable().optional(),
      track: z.number().nullable(),
      speed_kt: z.number().nullable(),
      emergency: z.boolean(),
      trail: z.array(LatLon),
    }),
  ),
  vehicles: z.array(z.object({ lat: z.number(), lon: z.number(), mode: z.string() })),
  /** Parts of the feed Loops did not send this time: their lists are unknown, not empty. */
  missing: z.array(z.enum(["location", "items", "aircraft", "live"])).optional(),
});
export type Osint = z.infer<typeof OsintSchema>;

export const MapSchema = z.object({
  center: z.object({ lat: z.number(), lon: z.number() }),
  roads: z.array(z.object({ class: z.string(), points: z.array(LatLon) })),
  water: z.array(z.array(LatLon)),
  green: z.array(z.array(LatLon)),
  /** Outlines for the 3D city: closed rings (last point repeats the first) with a height in metres. Absent when Loops sends none. */
  buildings: z.array(z.object({ ring: z.array(LatLon).min(4).max(13), height: z.number().min(3).max(150) })).max(80).optional(),
});
export type LocalMap = z.infer<typeof MapSchema>;

/** Everything the Code app shows, sent whole on every change (survives reconnects). */
export const CodeViewSchema = z.object({
  state: z.enum(["off", "idle", "recording", "transcribing", "working", "approval", "done", "error"]),
  project: z.string(),
  prompt: z.string(),
  log: z.array(z.string()),
  /** A tool call waiting on the glasses: `summary` is one short line (log, tab menu); `text` is the whole call, to show in full before a tap allows it. */
  approval: z
    .object({
      id: z.number().int(),
      summary: z.string(),
      text: z.string(),
      /** The tool asking, such as "Bash". */
      tool: z.string().max(24).optional(),
      /** The folder it runs in. */
      cwd: z.string().max(80).optional(),
      /** The call needs the network. */
      network: z.boolean().optional(),
    })
    .nullable(),
  result: z.string(),
  stats: z.string(),
  error: z.string(),
  startedAt: z.number().nullable(),
  /** The files this task touched, oldest first. */
  files: z.array(z.object({ path: z.string().min(1).max(120), state: z.enum(["read", "edit"]) })).max(24).optional(),
  /** The file being touched now. */
  current: z.string().max(120).nullable().optional(),
  /** Top-level folders of the project, with a file count each. */
  tree: z.array(z.object({ name: z.string().min(1).max(40), files: z.number().int().min(0) })).max(12).optional(),
  /** Lines added and removed by this task. */
  added: z.number().int().min(0).optional(),
  removed: z.number().int().min(0).optional(),
});
export type CodeView = z.infer<typeof CodeViewSchema>;

/** All Code tabs: each one a Claude Code session in a project. */
export const CodeHubSchema = z.object({
  tabs: z.array(z.object({ id: z.number().int(), view: CodeViewSchema })),
  error: z.string(),
});
export type CodeHub = z.infer<typeof CodeHubSchema>;

/**
 * Everything HackOS shows, sent whole on every change (survives reconnects).
 * One conversation, shared by the glasses and the Mac terminal.
 */
export const HackViewSchema = z.object({
  state: z.enum(["off", "idle", "recording", "transcribing", "waking", "thinking", "answering", "done", "error"]),
  model: z.string(),
  prompt: z.string(),
  answer: z.string(),
  stats: z.string(),
  error: z.string(),
  startedAt: z.number().nullable(),
  /** Finished turns, oldest first, for the terminal's scrollback. */
  history: z.array(z.object({ prompt: z.string(), answer: z.string() })),
  /** Recent tokens per second while an answer streams, oldest first. */
  rate: z.array(z.number().min(0)).max(22).optional(),
});
export type HackView = z.infer<typeof HackViewSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), data: CodeHubSchema }),
  z.object({ type: z.literal("hack"), data: HackViewSchema }),
  z.object({ type: z.literal("osint"), data: OsintSchema }),
  z.object({ type: z.literal("osint_map"), data: MapSchema }),
  z.object({ type: z.literal("status"), text: z.string() }),
  z.object({ type: z.literal("utterance"), text: z.string(), speaker: SpeakerSchema }),
  /** Claude is deciding whether the last line is a question. */
  z.object({ type: z.literal("thinking"), id: z.number().int() }),
  /** It was not a question; nothing will be shown. */
  z.object({ type: z.literal("answer_none"), id: z.number().int() }),
  /** `notes`: titles of the vault notes sent with this request. */
  z.object({ type: z.literal("answer_start"), id: z.number().int(), question: z.string(), notes: z.array(z.string().min(1).max(40)).max(6).optional() }),
  z.object({ type: z.literal("answer_delta"), id: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("answer_done"), id: z.number().int() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  /** Answers vault recall: a known person was named. Made on the Mac; the phone page logs only the name. */
  z.object({
    type: z.literal("recall"),
    name: z.string().min(1).max(60),
    facts: z.array(z.string().max(80)).min(1).max(3),
    /** The node of that person in the last `vault_graph`. */
    id: z.number().int().min(0).optional(),
    /** The lens card of this person. Every part is optional: a missing one is left off the card. */
    card: z
      .object({
        lead: z.string().max(80).optional(),
        met: z.number().int().min(0).optional(),
        seen: z.string().max(12).optional(),
        last: z.string().max(60).optional(),
        open: z.string().max(60).optional(),
      })
      .optional(),
  }),
  /** The Answers vault as a graph. Titles only, from notes the server may already quote. */
  z.object({
    type: z.literal("vault_graph"),
    nodes: z.array(z.object({ id: z.number().int().min(0), title: z.string().min(1).max(40), kind: z.enum(["person", "topic", "meeting"]) })).max(80),
    links: z.array(z.tuple([z.number().int(), z.number().int()])).max(240),
    /** How many notes and people the whole vault holds (the graph shows only some). */
    total: z.object({ notes: z.number().int().min(0), people: z.number().int().min(0) }).optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** A question typed on the phone, answered as if someone had asked it. */
  z.object({ type: z.literal("ask"), text: z.string().trim().min(1).max(2000) }),
  /** Forget the conversation so far. */
  z.object({ type: z.literal("reset") }),
  /** Save the current conversation to Obsidian now. */
  z.object({ type: z.literal("end_meeting") }),
  /** Code app: push-to-talk pressed or released, for a tab. `discard` on a release: drop what was heard, run nothing. */
  z.object({ type: z.literal("code_ptt"), tab: z.number().int(), on: z.boolean(), discard: z.boolean().optional() }),
  /** Code app: a typed instruction. */
  z.object({ type: z.literal("code_prompt"), tab: z.number().int(), text: z.string().trim().min(1).max(4000) }),
  /** Code app: allow or deny a tab's pending tool call. */
  z.object({ type: z.literal("code_decide"), tab: z.number().int(), id: z.number().int(), allow: z.boolean() }),
  /** Code app: stop a tab's running task. */
  z.object({ type: z.literal("code_stop"), tab: z.number().int() }),
  /** Code app: forget a tab's conversation and start fresh. */
  z.object({ type: z.literal("code_new"), tab: z.number().int() }),
  /** Code app: open a new tab on the same project as `tab`. */
  z.object({ type: z.literal("code_tab_open"), tab: z.number().int() }),
  /** Code app: close a tab (stops it first). */
  z.object({ type: z.literal("code_tab_close"), tab: z.number().int() }),
  /** HackOS: push-to-talk pressed or released. `discard` on a release: drop what was heard, send nothing. */
  z.object({ type: z.literal("hack_ptt"), on: z.boolean(), discard: z.boolean().optional() }),
  /** HackOS: a typed message. */
  z.object({ type: z.literal("hack_prompt"), text: z.string().trim().min(1).max(8000) }),
  /** HackOS: stop the answer that is being written. */
  z.object({ type: z.literal("hack_stop") }),
  /** HackOS: forget the conversation and start fresh. */
  z.object({ type: z.literal("hack_new") }),
  /** Where the phone is, for Around and Sky when the server fetches the open data itself. */
  z.object({ type: z.literal("position"), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracy: z.number().nonnegative().optional() }),
  /** Answers vault recall: the cue for this name was on the lens for 3 s. */
  z.object({ type: z.literal("recall_shown"), name: z.string().min(1).max(60) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
