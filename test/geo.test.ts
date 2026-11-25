import { describe, expect, it } from "vitest";
import { distanceLabel } from "../src/core/geo";

describe("distanceLabel", () => {
  it("rounds metres to 10 m below 1 km", () => {
    expect(distanceLabel(340)).toBe("340 m");
    expect(distanceLabel(994)).toBe("990 m");
  });
  it("switches to km when the rounded value reaches 1000 m", () => {
    expect(distanceLabel(995)).toBe("1.0 km");
    expect(distanceLabel(997)).toBe("1.0 km");
    expect(distanceLabel(999.9)).toBe("1.0 km");
    expect(distanceLabel(1000)).toBe("1.0 km");
    expect(distanceLabel(1450)).toBe("1.4 km");
  });
});
