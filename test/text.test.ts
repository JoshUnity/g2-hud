import { measureTextWrap } from "@evenrealities/pretext";
import { describe, expect, it } from "vitest";
import { LINE, MAX_TEXT_BYTES, clipPx, fitBytes, fitPx, paginatePx, textWidth, wrapPx } from "../src/core/text";

const LONG =
  "The aircraft landed at Schiphol after a short delay because the crew waited for a gate, and the passengers walked to the terminal in the rain.";
const MAX = 400;

describe("textWidth", () => {
  it("measures with the firmware font, with kerning", () => {
    expect(LINE).toBe(27);
    expect(textWidth("")).toBe(0);
    expect(textWidth("Hello")).toBe(42);
    expect(textWidth("Listening")).toBe(78);
    expect(textWidth("11:11")).toBeLessThan(textWidth("00:00"));
  });
});

describe("fitPx", () => {
  it("returns a string that already fits", () => expect(fitPx("Listening", 200)).toBe("Listening"));

  it("cuts with one … glyph, never three dots, and fits", () => {
    for (const max of [40, 90, 150, 300]) {
      const out = fitPx(LONG, max);
      expect(out.endsWith("…"), `${max}`).toBe(true);
      expect(out).not.toContain("...");
      expect(textWidth(out)).toBeLessThanOrEqual(max);
      // Not cut shorter than needed: one more character would not fit.
      const next = LONG.slice(0, out.length) + "…";
      expect(textWidth(next)).toBeGreaterThan(max);
    }
  });

  it("returns an empty string when not even the ellipsis fits", () => expect(fitPx(LONG, 3)).toBe(""));
});

describe("wrapPx", () => {
  it("fits every line in the limit, and the firmware agrees it is one line", () => {
    for (const max of [120, 250, MAX, 576]) {
      const lines = wrapPx(LONG, max);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(textWidth(line), `${max}: ${line}`).toBeLessThanOrEqual(max);
        expect(measureTextWrap(line, max).lineCount).toBe(1);
      }
      expect(lines.join(" ")).toBe(LONG);
    }
  });

  it("wraps on word boundaries", () => {
    expect(wrapPx("one two three four", textWidth("one two three"))).toEqual(["one two three", "four"]);
  });

  it("keeps blank lines between paragraphs", () => {
    expect(wrapPx("first\n\nsecond", 300)).toEqual(["first", "", "second"]);
    expect(wrapPx("", 300)).toEqual([]);
  });

  it("drops trailing blank lines", () => expect(wrapPx("text\n\n", 300)).toEqual(["text"]));

  it("hangs wrapped bullet lines under the text", () => {
    const lines = wrapPx("• one two three four five six seven eight nine ten", 150);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("• ")).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("   ")).toBe(true);
      expect(textWidth(line)).toBeLessThanOrEqual(150);
    }
    // The hang is as wide as the bullet and its space, within one space.
    expect(Math.abs(textWidth("   ") - textWidth("• "))).toBeLessThanOrEqual(textWidth(" "));
  });

  it("splits a word wider than the line", () => {
    const word = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    const lines = wrapPx(`go ${word} now`, 120);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(120);
    expect(lines.join("").replace(/\s/g, "")).toBe(`go${word}now`);
  });
});

describe("clipPx", () => {
  it("leaves short text alone", () => expect(clipPx("Short question?", MAX, 2)).toBe("Short question?"));

  it("keeps at most the given lines and ends with …", () => {
    const out = clipPx(LONG, 250, 2);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(250);
    expect(lines[0]).toBe(wrapPx(LONG, 250)[0]);
  });
});

describe("paginatePx", () => {
  it("always returns at least one page", () => expect(paginatePx("", 8, 576)).toEqual([""]));

  it("puts at most linesPerPage lines on a page", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Line number ${i} of the answer`).join("\n");
    const pages = paginatePx(text, 8, 576);
    expect(pages).toHaveLength(4);
    for (const page of pages) expect(page.split("\n").length).toBeLessThanOrEqual(8);
    expect(pages.join("\n")).toBe(text);
  });

  it("ends a page before it passes maxBytes", () => {
    const text = Array.from({ length: 40 }, () => "Wörd wörd wörd wörd wörd wörd wörd").join("\n");
    const pages = paginatePx(text, 20, 576);
    for (const page of pages) expect(new TextEncoder().encode(page).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("\n")).toBe(text);
  });

  it("honours a small custom byte cap", () => {
    const pages = paginatePx("aaaa\nbbbb\ncccc\ndddd", 10, 576, 9);
    expect(pages).toEqual(["aaaa\nbbbb", "cccc\ndddd"]);
  });
});

describe("fitBytes", () => {
  it("cuts on character boundaries", () => {
    const out = fitBytes("éééééé", 8);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(8);
  });
});
