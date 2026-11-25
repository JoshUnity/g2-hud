/** Root-mean-square level of 16-bit little-endian PCM, mapped to 0..1 for the voice meters. */
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
