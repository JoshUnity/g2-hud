import { getTextWidth } from "@evenrealities/pretext";

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

/**
 * Pixel measurement with Even's own library, `@evenrealities/pretext`. It
 * follows the firmware's font and kerning, so use these and never count
 * characters.
 */

/** The firmware's line height in pixels. */
export const LINE = 27;

/** The single-line width of a string, in pixels. */
export const textWidth = (text: string): number => getTextWidth(text);

/** One line of at most `maxPx` pixels: cut with "…" (one glyph, not three dots) when it is too wide. */
export function fitPx(text: string, maxPx: number): string {
  if (textWidth(text) <= maxPx) return text;
  const chars = [...text];
  // The most characters that still fit with the ellipsis: a binary search on a rising width.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(chars.slice(0, mid).join("").trimEnd() + "…") <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  const out = chars.slice(0, lo).join("").trimEnd() + "…";
  return textWidth(out) <= maxPx ? out : "";
}

/**
 * Word-wraps text into lines that each fit in `maxPx`, so the firmware never
 * wraps them again. Same rules as `wrap` in the Answers HUD: blank lines between
 * paragraphs stay, wrapped lines of a "• " bullet hang under its text, and a
 * word wider than the line is split.
 */
export function wrapPx(text: string, maxPx: number): string[] {
  const lines: string[] = [];
  const hang = " ".repeat(Math.ceil(textWidth("• ") / textWidth(" ")));
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    const indent = paragraph.startsWith("• ") ? hang : "";
    let line = "";
    const flush = (): void => {
      lines.push(line);
      line = indent;
    };
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.trim() && textWidth(`${line} ${word}`) <= maxPx) {
        line += " " + word;
        continue;
      }
      if (line.trim()) flush();
      let rest = [...word];
      while (rest.length > 0 && textWidth(line + rest.join("")) > maxPx) {
        // A word wider than the line: the longest piece that fits, and at least one character.
        let cut = 1;
        while (cut < rest.length - 1 && textWidth(line + rest.slice(0, cut + 1).join("")) <= maxPx) cut++;
        lines.push(line + rest.slice(0, cut).join(""));
        line = indent;
        rest = rest.slice(cut);
      }
      line += rest.join("");
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** At most `lines` wrapped lines, with "…" when cut. */
export function clipPx(text: string, maxPx: number, lines: number): string {
  const all = wrapPx(text, maxPx);
  if (all.length <= lines) return all.join("\n");
  const kept = all.slice(0, lines);
  kept[lines - 1] = fitPx((kept[lines - 1] ?? "").trimEnd() + "…", maxPx);
  return kept.join("\n");
}

/**
 * Splits text into screen-sized pages. Always returns at least one page.
 * A page also ends before it passes maxBytes, so the byte cap of the text container never cuts text off a page.
 */
export function paginatePx(text: string, linesPerPage: number, maxPx: number, maxBytes = MAX_TEXT_BYTES): string[] {
  const encoder = new TextEncoder();
  const pages: string[] = [];
  let page: string[] = [];
  let bytes = 0;
  for (const line of wrapPx(text, maxPx)) {
    // The line plus its "\n" separator.
    const size = encoder.encode(line).length + 1;
    if (page.length === linesPerPage || (page.length > 0 && bytes + size - 1 > maxBytes)) {
      pages.push(page.join("\n"));
      page = [];
      bytes = 0;
    }
    page.push(line);
    bytes += size;
  }
  if (page.length > 0) pages.push(page.join("\n"));
  return pages.length > 0 ? pages : [""];
}
