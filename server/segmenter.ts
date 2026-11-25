import type { Speaker } from "../src/core/protocol";

/** 16 kHz, 16-bit mono PCM. */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

export type Segment = { pcm: Buffer; speakers: Speaker[]; durationMs: number };

export type SegmenterOptions = {
  /** Silence that ends an utterance. */
  silenceMs: number;
  /** Shorter bursts (a cough, a tap) are dropped. */
  minSpeechMs: number;
  /** Long speech is cut here so answers do not wait for a monologue to end. */
  maxSpeechMs: number;
  /** Audio kept from just before speech starts, so the first word is not clipped. */
  preRollMs: number;
  /** Lowest level (RMS of 16-bit samples) that can count as speech. */
  minThreshold: number;
};

const DEFAULTS: SegmenterOptions = {
  silenceMs: 700,
  minSpeechMs: 400,
  maxSpeechMs: 15_000,
  preRollMs: 300,
  minThreshold: 400,
};

/** Root mean square of 16-bit little-endian samples. */
export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** The speaker with the most frames; "unknown" only when nobody else was tagged. */
export function dominantSpeaker(speakers: Speaker[]): Speaker {
  let self = 0;
  let other = 0;
  for (const s of speakers) {
    if (s === "self") self++;
    else if (s === "other") other++;
  }
  if (self === 0 && other === 0) return "unknown";
  return self > other ? "self" : "other";
}

type Frame = { pcm: Buffer; speaker: Speaker; ms: number };

/**
 * Cuts a live audio stream into utterances with a simple energy detector:
 * speech starts when the level rises well above the background noise and
 * ends after a stretch of silence.
 */
export class Segmenter {
  private options: SegmenterOptions;
  private noiseFloor: number | null = null;
  private preRoll: Frame[] = [];
  private frames: Frame[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  /** Lowest frame level of the open utterance. */
  private minLevel = Infinity;

  constructor(
    private onSegment: (segment: Segment) => void,
    options: Partial<SegmenterOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  push(pcm: Buffer, speaker: Speaker): void {
    const frame: Frame = { pcm, speaker, ms: pcm.length / BYTES_PER_MS };
    const level = rms(pcm);
    // Start low, so speech in the very first frames is not taken for background noise.
    const floor = this.noiseFloor ?? Math.min(level, this.options.minThreshold);
    const threshold = Math.max(this.options.minThreshold, floor * 3);
    const loud = level > threshold;

    if (this.frames.length === 0) {
      if (!loud) {
        // Falls fast to quieter background (but not from one frame), rises slowly with louder background.
        this.noiseFloor = level < floor ? (floor + level) / 2 : floor * 0.95 + level * 0.05;
        this.preRoll.push(frame);
        let kept = this.preRoll.reduce((sum, f) => sum + f.ms, 0);
        while (kept > this.options.preRollMs && this.preRoll.length > 0) kept -= this.preRoll.shift()?.ms ?? 0;
        return;
      }
      this.frames = [...this.preRoll, frame];
      this.preRoll = [];
      this.speechMs = frame.ms;
      this.silenceMs = 0;
      this.minLevel = level;
      return;
    }

    this.frames.push(frame);
    this.minLevel = Math.min(this.minLevel, level);
    if (loud) {
      this.speechMs += this.silenceMs + frame.ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frame.ms;
    }
    if (this.silenceMs >= this.options.silenceMs) this.finish();
    else if (this.speechMs >= this.options.maxSpeechMs) {
      // No pause for this long: the quietest level in the utterance is background, not speech.
      this.noiseFloor = Math.max(floor, this.minLevel);
      this.finish();
    }
  }

  /** Ends any utterance in progress (for example when the connection closes). */
  flush(): void {
    if (this.frames.length > 0) this.finish();
  }

  /** Drops the audio held so far, without a segment (a recording that is thrown away). The noise floor stays. */
  reset(): void {
    this.preRoll = [];
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private finish(): void {
    const frames = this.frames;
    const speechMs = this.speechMs;
    this.frames = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    if (speechMs < this.options.minSpeechMs) return;
    this.onSegment({
      pcm: Buffer.concat(frames.map((f) => f.pcm)),
      speakers: frames.map((f) => f.speaker),
      durationMs: frames.reduce((sum, f) => sum + f.ms, 0),
    });
  }
}
