import { ImageContainerProperty } from "@evenrealities/even_hub_sdk";
import type { Box } from "../core/box";
import { LENS_TILES, STATUS_AT } from "../core/board";

import { LIGHT, textProp, type Cell } from "../core/hud";
import type { PageSpec } from "../core/page";
import { LINE } from "../core/text";

/**
 * The one fixed page, for every state: the four tiles of the lens raster (ids 1 to 4) behind, and eight glasses-text
 * containers in front, at the places where the board draws its text (`tx`). `zOrderIndex` on every container:
 * images 1 to 4, texts 10 and up.
 */
/** The status, at the board's (32, 0), up to the pixel clock (x 518, less a gap). */
export const STATUS: Box = { id: 5, name: "status", x: STATUS_AT.x, y: STATUS_AT.y, width: 478, height: LINE };
/** The question (or the compact cue): two lines from (0, 36). */
export const QUESTION: Box = { id: 6, name: "question", x: 0, y: 36, width: 576, height: 2 * LINE };
/** The answer and the other body texts: from (0, 72) to the foot of the lens. It takes the input. */
export const BODY: Box = { id: 7, name: "body", x: 0, y: 72, width: 576, height: 8 * LINE };
/** The hint, at the board's (0, 255). */
export const HINT: Box = { id: 8, name: "hint", x: 0, y: 255, width: 576, height: LINE };
/** The recall card's four lines, at the board's (304, 82), (304, 109), (304, 154) and (304, 198). */
export const CARD_LINES: Box[] = [82, 109, 154, 198].map((y, i) => ({ id: 9 + i, name: `card${i + 1}`, x: 304, y, width: 272, height: LINE }));

/** The text boxes in the order they are updated. */
export const TEXT_BOXES: Box[] = [STATUS, QUESTION, BODY, HINT, ...CARD_LINES];

const tile = (box: Box, i: number): ImageContainerProperty =>
  new ImageContainerProperty({ xPosition: box.x, yPosition: box.y, width: box.width, height: box.height, containerID: box.id, containerName: box.name, zOrderIndex: i + 1 });

export function pageSpec(cells: Record<string, Cell>): PageSpec {
  const cell = (box: Box): Cell => cells[box.name] ?? { content: "", color: LIGHT.ambient };
  return {
    containerTotalNum: LENS_TILES.length + TEXT_BOXES.length,
    imageObject: LENS_TILES.map(tile),
    textObject: TEXT_BOXES.map((box, i) => textProp(box, cell(box), { isEventCapture: box === BODY ? 1 : 0, zOrderIndex: 10 + i })),
  };
}
