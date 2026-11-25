import { OsEventTypeList, evenHubEventFromJson } from "@evenrealities/even_hub_sdk";
import { describe, expect, it } from "vitest";
import { eventTypeOf } from "../src/core/events";

const typeOf = (type: string, jsonData: Record<string, unknown>) => eventTypeOf(evenHubEventFromJson({ type, jsonData }));

describe("eventTypeOf", () => {
  it("reads a tap on sysEvent with no eventType as CLICK_EVENT", () => {
    // The shape the templates README and the G2 hardware reports give for a tap.
    expect(typeOf("sysEvent", { eventSource: 1 })).toBe(OsEventTypeList.CLICK_EVENT);
    expect(typeOf("sysEvent", { eventSource: 2 })).toBe(OsEventTypeList.CLICK_EVENT);
    expect(typeOf("sysEvent", {})).toBe(OsEventTypeList.CLICK_EVENT);
  });

  it("reads a tap on textEvent with no eventType as CLICK_EVENT", () => {
    expect(typeOf("textEvent", { containerID: 4, containerName: "card" })).toBe(OsEventTypeList.CLICK_EVENT);
  });

  it("keeps explicit types on both envelopes", () => {
    expect(typeOf("sysEvent", { eventType: 0 })).toBe(OsEventTypeList.CLICK_EVENT);
    expect(typeOf("sysEvent", { eventType: 3, eventSource: 1 })).toBe(OsEventTypeList.DOUBLE_CLICK_EVENT);
    expect(typeOf("sysEvent", { eventType: 4 })).toBe(OsEventTypeList.FOREGROUND_ENTER_EVENT);
    expect(typeOf("sysEvent", { eventType: 9 })).toBe(OsEventTypeList.LONG_PRESS_EVENT);
    expect(typeOf("sysEvent", { eventType: 10 })).toBe(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    expect(typeOf("textEvent", { eventType: 1 })).toBe(OsEventTypeList.SCROLL_TOP_EVENT);
    expect(typeOf("textEvent", { eventType: 2 })).toBe(OsEventTypeList.SCROLL_BOTTOM_EVENT);
  });

  it("does not read a type the SDK does not know as a tap", () => {
    expect(typeOf("sysEvent", { eventType: 11 })).toBeUndefined();
    expect(typeOf("sysEvent", { Event_Type: 11 })).toBeUndefined();
    expect(typeOf("sysEvent", { event_type: 11 })).toBeUndefined();
    expect(typeOf("sysEvent", { eventType: "SOMETHING_NEW" })).toBeUndefined();
    expect(typeOf("textEvent", { eventType: 11 })).toBeUndefined();
  });

  it("gives undefined for audio and menu events", () => {
    expect(typeOf("audioEvent", { audioPcm: [1, 2, 3] })).toBeUndefined();
    expect(typeOf("menuItemClickEvent", { itemID: 5 })).toBeUndefined();
  });
});
