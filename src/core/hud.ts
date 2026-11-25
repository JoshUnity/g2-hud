import { ImageContainerProperty, TextContainerProperty } from "@evenrealities/even_hub_sdk";
import type { Box } from "./box";
import { LINE, fitBytes, textWidth } from "./text";

/**
 * The layout the three text apps (Answers, Code, HackOS) share: one header row,
 * then a prompt, then the body. See DESIGN.md, "Layout". Text is measured in
 * pixels with LINE (27 px) as the line height, never counted in characters.
 */

/** Light levels (text brightness). Brighter means nearer and more important. */
export const LIGHT = { primary: 4, near: 3, secondary: 2, ambient: 1 } as const;

export type Cell = { content: string; color: number };

const WIDTH = 576;
const GAP = 8;
/** The widest time the clock can show, so the box never wraps and the right edge stays flush. */
const CLOCK_WIDTH = Math.max(...Array.from({ length: 10 }, (_, d) => textWidth(`${d}${d}:${d}${d}`)));

/** The header icon: 24 x 24 at the left edge. */
export const ICON_BOX: Box = { id: 5, name: "icon", x: 0, y: 2, width: 24, height: 24 };
/** The clock, flush to the right edge. */
export const CLOCK: Box = { id: 2, name: "clock", x: WIDTH - CLOCK_WIDTH, y: 0, width: CLOCK_WIDTH, height: LINE };
/** The status line, between the icon and the clock. */
export const STATUS: Box = { id: 1, name: "status", x: 32, y: 0, width: CLOCK.x - GAP - 32, height: LINE };
/**
 * The prompt (the question, the instruction) and the body overlap on purpose.
 * With a one-line prompt the body keeps its 8 lines from y 66. With a two-line
 * prompt the body starts with one empty line and holds 7.
 */
export const PROMPT: Box = { id: 3, name: "prompt", x: 0, y: 30, width: WIDTH, height: 2 * LINE };
export const BODY: Box = { id: 4, name: "body", x: 0, y: 66, width: WIDTH, height: 8 * LINE };
export const BODY_LINES = 8;

/** How many lines a prompt takes: 1 (also when it is empty) or 2. */
export const promptLines = (content: string): 1 | 2 => (content.split("\n").length >= 2 ? 2 : 1);

/** Body lines left under the prompt. */
export const bodyLinesFor = (promptContent: string): 7 | 8 => (promptLines(promptContent) === 2 ? 7 : 8);

/** The body text for a page: it starts with an empty line when the prompt has two lines. */
export const bodyContent = (promptContent: string, page: string): string => (promptLines(promptContent) === 2 ? "\n" + page : page);

/** A text container: no padding, no border, no input unless `extra` says so. */
export function textProp(box: Box, cell: Cell, extra: Partial<TextContainerProperty> = {}): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: box.x, yPosition: box.y, width: box.width, height: box.height,
    containerID: box.id, containerName: box.name, content: fitBytes(cell.content), textColor: cell.color,
    paddingLength: 0, isEventCapture: 0, ...extra,
  });
}

export function iconProp(box: Box = ICON_BOX): ImageContainerProperty {
  return new ImageContainerProperty({
    xPosition: box.x, yPosition: box.y, width: box.width, height: box.height, containerID: box.id, containerName: box.name,
  });
}
