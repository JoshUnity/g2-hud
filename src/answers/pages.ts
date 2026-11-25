import { ImageContainerProperty, TextContainerProperty, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Box } from "../core/box";
import { openPage } from "../core/page";
import { CARD, CLOCK, LIGHT, QUESTION, SIGIL, STATUS, fitBytes, type Cell } from "./hud";

export const TEXT_BOXES: Box[] = [STATUS, CLOCK, QUESTION, CARD];

function text(box: Box, cell: Cell, extra: Partial<TextContainerProperty> = {}): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: box.x, yPosition: box.y, width: box.width, height: box.height,
    containerID: box.id, containerName: box.name, content: fitBytes(cell.content), textColor: cell.color,
    paddingLength: 0, isEventCapture: 0, ...extra,
  });
}

export async function createPage(bridge: EvenAppBridge, cells: Record<string, Cell>): Promise<boolean> {
  const cell = (box: Box): Cell => cells[box.name] ?? { content: "", color: LIGHT.secondary };
  return openPage(bridge, {
    containerTotalNum: 5,
    imageObject: [
      new ImageContainerProperty({
        xPosition: SIGIL.x, yPosition: SIGIL.y, width: SIGIL.width, height: SIGIL.height,
        containerID: SIGIL.id, containerName: SIGIL.name,
      }),
    ],
    textObject: [
      text(STATUS, cell(STATUS)),
      text(CLOCK, cell(CLOCK)),
      text(QUESTION, cell(QUESTION)),
      // The card is the rounded frame, and it takes the input.
      text(CARD, cell(CARD), { borderWidth: 1, borderColor: 5, borderRadius: 8, paddingLength: 8, isEventCapture: 1 }),
    ],
  });
}
