import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pastMeetingsInclude, setPastMeetings, userContent, vaultRule } from "../server/answer";
import { NoneGate } from "../server/gate";
import { recentMeetings } from "../server/meetings";
import { renderNote } from "../server/notes";
import { BYTES_PER_MS, Segmenter, dominantSpeaker, rms, type Segment } from "../server/segmenter";
import { cleanTranscript, toWav } from "../server/whisper";
import { speakerCode, speakerFromCode, type Speaker } from "../src/core/protocol";

/** 100 ms of audio: silence, or a tone loud enough to count as speech. */
function frame(loud: boolean): Buffer {
  const samples = (BYTES_PER_MS * 100) / 2;
  const pcm = Buffer.alloc(samples * 2);
  if (loud) for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(i / 5)), i * 2);
  return pcm;
}

function run(pattern: string, speaker: Speaker = "other"): Segment[] {
  const out: Segment[] = [];
  const segmenter = new Segmenter((s) => out.push(s));
  for (const c of pattern) segmenter.push(frame(c === "#"), speaker);
  segmenter.flush();
  return out;
}

describe("Segmenter", () => {
  it("emits one utterance after a pause, with pre-roll", () => {
    const [segment, ...rest] = run(".....##########........");
    expect(rest).toHaveLength(0);
    // 300 ms pre-roll + 1000 ms speech + 700 ms trailing silence
    expect(segment?.durationMs).toBe(2000);
  });
  it("drops short bursts", () => {
    expect(run("....##.........")).toHaveLength(0);
  });
  it("keeps short gaps inside one utterance", () => {
    expect(run("..#####...#####........")).toHaveLength(1);
  });
  it("cuts very long speech", () => {
    // Speech with short gaps: a 16 s tone with no gap at all is steady background, not speech (see segmenter.test.ts).
    expect(run("#########.".repeat(16) + "........").length).toBe(2);
  });
  it("measures loudness", () => {
    expect(rms(frame(false))).toBe(0);
    expect(rms(frame(true))).toBeGreaterThan(2000);
  });
});

describe("dominantSpeaker", () => {
  it("picks the speaker with most frames and ignores unknown", () => {
    expect(dominantSpeaker(["self", "other", "other", "unknown"])).toBe("other");
    expect(dominantSpeaker(["unknown", "self", "unknown"])).toBe("self");
    expect(dominantSpeaker(["unknown"])).toBe("unknown");
  });
});

describe("whisper helpers", () => {
  it("writes a 16 kHz mono WAV header", () => {
    const wav = toWav(Buffer.alloc(320));
    expect(wav.length).toBe(364);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(320);
  });
  it("removes non-speech markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(music) What do you do?")).toBe("What do you do?");
  });
});

describe("NoneGate", () => {
  it("drops a NONE reply streamed in pieces", () => {
    const gate = new NoneGate();
    expect(gate.feed("NO").decision).toBe("pending");
    expect(gate.feed("NE").decision).toBe("none");
  });
  it("releases a real answer, including words that start like NONE", () => {
    const gate = new NoneGate();
    expect(gate.feed("N").decision).toBe("pending");
    expect(gate.feed("o, I think")).toEqual({ decision: "answer", text: "No, I think" });
    expect(gate.feed(" so")).toEqual({ decision: "answer", text: " so" });
  });
  it("matches the sentinel case-sensitively, so answers that start with None are shown", () => {
    const first = new NoneGate();
    expect(first.feed("None")).toEqual({ decision: "answer", text: "None" });
    expect(first.feed(" from my side.")).toEqual({ decision: "answer", text: " from my side." });
    expect(new NoneGate().feed("None of them have signed yet.").decision).toBe("answer");
    expect(new NoneGate().feed("Non").decision).toBe("answer");
    expect(new NoneGate().feed("none that I know of.").decision).toBe("answer");
    const dotted = new NoneGate();
    expect(dotted.feed("NONE.").decision).toBe("none");
    const trailing = new NoneGate();
    expect(trailing.feed(" NONE").decision).toBe("none");
    expect(trailing.feed("\n\nnot a question").decision).toBe("none");
  });
  it("treats an empty reply as NONE", () => {
    const gate = new NoneGate();
    gate.feed("  ");
    expect(gate.isNoneAtEnd()).toBe(true);
  });
});

describe("speaker codes", () => {
  it("round-trips", () => {
    for (const s of ["self", "other", "unknown"] as const) expect(speakerFromCode(speakerCode(s))).toBe(s);
    expect(speakerFromCode(99)).toBe("unknown");
  });
});

describe("vault recall in the prompt", () => {
  it("keeps the user message byte-identical without vault notes", () => {
    const lines = [{ speaker: "other" as const, text: "Hi" }];
    expect(userContent(lines, "", "T")).toBe("Current time: T\n\n<transcript>\nThem: Hi\n</transcript>");
    expect(userContent(lines, "<vault_notes>\nX\n</vault_notes>", "T")).toBe(
      "Current time: T\n\n<vault_notes>\nX\n</vault_notes>\n\n<transcript>\nThem: Hi\n</transcript>",
    );
  });

  it("adds the vault rule only when recall is on", () => {
    expect(vaultRule(false)).toBe("");
    expect(vaultRule(true).startsWith("\n- A <vault_notes> block")).toBe(true);
  });

  it("knows which meetings are already in the past meeting notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2-past-"));
    try {
      const at = new Date(2026, 10, 12, 14, 5);
      const summary = {
        title: "Pricing plan with Sarah",
        summary: "Sarah and I went over pricing.",
        decisions: [],
        action_items: [],
        people: ["Sarah"],
        topics: [],
      };
      await writeFile(join(dir, "2026-11-12 14-05 Pricing plan with Sarah.md"), renderNote(summary.title, summary, [{ at, speaker: "other", text: "Hi" }], []));
      setPastMeetings(await recentMeetings(dir));
      expect(pastMeetingsInclude("2026-11-12 14-05 Pricing plan with Sarah")).toBe(true);
      expect(pastMeetingsInclude("2026-11-12 14-05 Pricing plan")).toBe(false);
      expect(pastMeetingsInclude("2026-10-03 10-00 Atlas migration kickoff")).toBe(false);
    } finally {
      setPastMeetings("");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
