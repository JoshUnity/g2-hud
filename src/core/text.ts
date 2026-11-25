/** Text containers accept at most 999 bytes; stay below it. */
export const MAX_TEXT_BYTES = 960;

/** Cuts a string so its UTF-8 encoding fits in maxBytes, without splitting a character. */
export function fitBytes(text: string, maxBytes = MAX_TEXT_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > maxBytes - 3) break;
    out += char;
    used += size;
  }
  return out + "...";
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clockText = (now: Date) => `${pad(now.getHours())}:${pad(now.getMinutes())}`;

/** Shortens a line to `max` characters with "…". */
export const ellipsis = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
