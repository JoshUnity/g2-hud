/**
 * Display calibration: the one place that turns the board's logical grey levels into the levels we send.
 *
 * The board draws 16 levels, each 15 steps of brightness apart (`level / 15`, linear). The Even Hub simulator
 * does not show them that way. It reads each Gray8 byte as `round(value / 17)`, a device level 0 to 15, and
 * then shows that level through a strong brightening curve. Measured with a 16-step ramp sent through
 * `updateImageRawData` (see DESIGN.md, "Display curve"), device levels 1 to 8 show these alpha values and
 * levels 9 to 15 are all 255:
 *
 *   device level  1    2    3    4    5    6    7    8    9..15
 *   shown alpha   96   131  157  179  197  214  230  244  255
 *
 * So level 5 of 15, which is 33% on the board, shows 77% in the simulator, and the dim parts of a board
 * (links at alpha .3, .22) look almost as bright as the lit ones. `DISPLAY_CURVE = "simulator"` sends, for each
 * logical level, the device level whose shown brightness is nearest to `level / 15`. A lit level never maps to
 * 0, so a non-zero level stays visible. The seven device levels 9 to 15 are one and the same white, so the
 * top logical level keeps 255.
 *
 * Only real glasses can say which curve they follow. If they show the 16 levels linearly, set
 * `DISPLAY_CURVE = "linear"`: then nothing changes on the way to the lens.
 */

export type DisplayCurve = "simulator" | "linear";

export const DISPLAY_CURVE: DisplayCurve = "simulator";

/** Alpha (0 to 255) the simulator shows for each device level 0 to 15, as measured. */
export const SIMULATOR_ALPHA: readonly number[] = [0, 96, 131, 157, 179, 197, 214, 230, 244, 255, 255, 255, 255, 255, 255, 255];

/**
 * The device level to send for each logical level 0 to 15 on the simulator curve. Levels 1 to 6 all
 * become device level 1 (they cannot be told apart in the simulator), 7 and 8 become 2, 10 and 11 become 4.
 * Every other level keeps a level of its own.
 */
export const SIMULATOR_LEVELS: readonly number[] = [0, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 4, 5, 6, 8, 15];

/** The device level for each logical level on the active curve. */
export const DEVICE_LEVELS: readonly number[] = DISPLAY_CURVE === "simulator" ? SIMULATOR_LEVELS : Array.from({ length: 16 }, (_, i) => i);

/** Byte to byte: the 0 to 255 value to send for a 0 to 255 value the renderers drew. */
const LUT: Uint8Array = Uint8Array.from({ length: 256 }, (_, v) => (DEVICE_LEVELS[Math.round(v / 17)] ?? 15) * 17);

/** The frame to send for a rendered frame: every pixel goes through the display curve. The input is not changed. */
export function calibrate(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = LUT[pixels[i] as number] as number;
  return out;
}
