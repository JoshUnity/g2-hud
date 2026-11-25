import { describe, expect, it } from "vitest";
import { BODY, BODY_LINES, CLOCK, ICON_BOX, LIGHT, PROMPT, STATUS, bodyContent, bodyLinesFor, iconProp, promptLines, textProp } from "../src/core/hud";
import { LINE, textWidth } from "../src/core/text";

describe("HUD boxes", () => {
  it("has the verified geometry", () => {
    expect(LIGHT).toEqual({ primary: 4, near: 3, secondary: 2, ambient: 1 });
    expect(ICON_BOX).toMatchObject({ id: 5, x: 0, y: 2, width: 24, height: 24 });
    expect(STATUS).toMatchObject({ id: 1, x: 32, y: 0, height: LINE });
    expect(CLOCK).toMatchObject({ id: 2, y: 0, height: LINE });
    expect(PROMPT).toMatchObject({ id: 3, x: 0, y: 30, width: 576, height: 2 * LINE });
    expect(BODY).toMatchObject({ id: 4, x: 0, y: 66, width: 576, height: 8 * LINE });
    expect(BODY_LINES).toBe(8);
  });

  it("keeps every box on the 576 x 288 lens", () => {
    for (const box of [ICON_BOX, STATUS, CLOCK, PROMPT, BODY]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(576);
      expect(box.y + box.height).toBeLessThanOrEqual(288);
    }
  });

  it("puts the clock at the right edge and leaves an 8 px gap before it", () => {
    expect(CLOCK.x + CLOCK.width).toBe(576);
    expect(STATUS.x + STATUS.width + 8).toBe(CLOCK.x);
  });

  it("makes the clock wide enough for every time of day, so the firmware never wraps it", () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const text = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        expect(textWidth(text), text).toBeLessThanOrEqual(CLOCK.width);
      }
    }
  });

  it("lets only the prompt and the body overlap", () => {
    const boxes = [ICON_BOX, STATUS, CLOCK, PROMPT, BODY];
    const overlap = (a: typeof BODY, b: typeof BODY) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const pairs: string[] = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => overlap(a, b) && pairs.push(`${a.name}/${b.name}`)));
    expect(pairs).toEqual(["prompt/body"]);
    // A one-line prompt ends above the body; the body line 1 starts at BODY.y either way.
    expect(PROMPT.y + LINE).toBeLessThanOrEqual(BODY.y);
  });
});

describe("prompt and body", () => {
  it("counts prompt lines and gives the body 8 or 7 lines", () => {
    expect(promptLines("")).toBe(1);
    expect(promptLines("one line")).toBe(1);
    expect(promptLines("one\ntwo")).toBe(2);
    expect(bodyLinesFor("one")).toBe(8);
    expect(bodyLinesFor("one\ntwo")).toBe(7);
  });

  it("starts the body with an empty line under a two-line prompt", () => {
    expect(bodyContent("one", "text")).toBe("text");
    expect(bodyContent("one\ntwo", "text")).toBe("\ntext");
  });
});

describe("single containers", () => {
  it("builds single containers the same way", () => {
    expect(textProp(BODY, { content: "x", color: 3 }, { isEventCapture: 1 })).toMatchObject({ containerID: 4, textColor: 3, isEventCapture: 1, paddingLength: 0 });
    expect(iconProp()).toMatchObject({ containerID: 5, width: 24 });
  });
});
