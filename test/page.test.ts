import { MenuContainerProperty, MenuItemProperty, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPage, type PageSpec } from "../src/core/page";

function fakeBridge(created: StartUpPageCreateResult, rebuilt: boolean | boolean[]) {
  const calls: string[] = [];
  let rebuildArg: RebuildPageContainer | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      calls.push("create");
      return created;
    },
    rebuildPageContainer: async (c: RebuildPageContainer) => {
      calls.push("rebuild");
      rebuildArg = c;
      return Array.isArray(rebuilt) ? (rebuilt.shift() ?? false) : rebuilt;
    },
  } as unknown as EvenAppBridge;
  return { bridge, calls, rebuildArg: () => rebuildArg };
}

const spec: PageSpec = {
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({ containerID: 1, containerName: "card", content: "hi", isEventCapture: 1 })],
  menuObject: new MenuContainerProperty({ menuItems: [new MenuItemProperty({ itemID: 1, itemName: "1  tab" })] }),
};

describe("openPage", () => {
  it("creates the start-up page and does not rebuild when create succeeds", async () => {
    const f = fakeBridge(StartUpPageCreateResult.success, false);
    expect(await openPage(f.bridge, spec)).toBe(true);
    expect(f.calls).toEqual(["create"]);
  });

  it("falls back to a rebuild with the same containers when create is refused (page reload)", async () => {
    const f = fakeBridge(StartUpPageCreateResult.invalid, true);
    expect(await openPage(f.bridge, spec)).toBe(true);
    expect(f.calls).toEqual(["create", "rebuild"]);
    expect(f.rebuildArg()?.textObject?.[0]?.containerName).toBe("card");
    expect(f.rebuildArg()?.menuObject?.menuItems?.[0]?.itemName).toBe("1  tab");
  });

  it("reports false when both create and rebuild fail", async () => {
    const f = fakeBridge(StartUpPageCreateResult.invalid, false);
    expect(await openPage(f.bridge, spec)).toBe(false);
  });

  describe("after the splash (startedUp)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("rebuilds at once and never creates", async () => {
      const f = fakeBridge(StartUpPageCreateResult.success, true);
      expect(await openPage(f.bridge, spec, true)).toBe(true);
      expect(f.calls).toEqual(["rebuild"]);
      expect(f.rebuildArg()?.textObject?.[0]?.containerName).toBe("card");
    });

    it("tries a rebuild once more after 300 ms", async () => {
      const f = fakeBridge(StartUpPageCreateResult.success, [false, true]);
      const result = openPage(f.bridge, spec, true);
      await vi.advanceTimersByTimeAsync(299);
      expect(f.calls).toEqual(["rebuild"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe(true);
      expect(f.calls).toEqual(["rebuild", "rebuild"]);
    });

    it("reports false when both rebuilds fail", async () => {
      const f = fakeBridge(StartUpPageCreateResult.success, false);
      const result = openPage(f.bridge, spec, true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await result).toBe(false);
      expect(f.calls).toEqual(["rebuild", "rebuild"]);
    });
  });
});
