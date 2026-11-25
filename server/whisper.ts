import { z } from "zod";
import { SAMPLE_RATE } from "./segmenter";

/** whisper.cpp's whisper-server, started by `npm run dev`. */
const WHISPER_URL = process.env.WHISPER_URL ?? "http://127.0.0.1:8178/inference";

const ResponseSchema = z.object({ text: z.string() });

/** Wraps 16-bit mono PCM in a WAV header. */
export function toWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Removes Whisper's non-speech markers such as "[BLANK_AUDIO]" or "(music)". */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class WhisperUnavailableError extends Error {}

export async function transcribe(pcm: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(toWav(pcm))], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  let response: Response;
  try {
    response = await fetch(WHISPER_URL, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new WhisperUnavailableError(`Speech-to-text is not reachable at ${WHISPER_URL}: ${String(error)}`);
  }
  if (!response.ok) throw new Error(`Speech-to-text returned HTTP ${response.status}`);
  return cleanTranscript(ResponseSchema.parse(await response.json()).text);
}
