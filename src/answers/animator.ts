import type { Box } from "../core/box";
import type { Producer } from "../core/imagepipe";
import { renderSigil, sigilFps, type SigilMode } from "./sigil";

/** The Sigil as an image producer: tracks its mode and a smoothed voice level. */
export class Sigil {
  private mode: SigilMode = "connecting";
  private modeAt = performance.now();
  private level = 0;
  private target = 0;

  constructor(private box: Box) {}

  setMode(mode: SigilMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeAt = performance.now();
  }

  /** Voice level from 0 to 1; smoothed so the Sigil swells, not twitches. */
  setLevel(level: number): void {
    this.target = Math.max(this.target, Math.max(0, Math.min(1, level)));
  }

  producer(): Producer {
    return {
      box: this.box,
      fps: () => sigilFps(this.mode, (performance.now() - this.modeAt) / 1000, this.level),
      render: (t) => {
        this.level += (this.target - this.level) * 0.35;
        this.target *= 0.8;
        return renderSigil(this.mode, t, (performance.now() - this.modeAt) / 1000, this.level, this.box.width);
      },
    };
  }
}

/** Root-mean-square level of 16-bit little-endian PCM, mapped to 0..1 for the Sigil. */
export function voiceLevel(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples);
  return Math.max(0, Math.min(1, (rms - 250) / 2500));
}
