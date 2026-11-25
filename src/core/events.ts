import { OsEventTypeList, normalizeLooseKey, type EvenHubEvent } from "@evenrealities/even_hub_sdk";

/**
 * The gesture type of a text or system event, or undefined for any other event.
 * CLICK_EVENT is 0 and the host leaves zero values out, so a tap has no
 * eventType. It can arrive as sysEvent {eventSource} or as textEvent. A type
 * this SDK does not know also parses to no eventType, but the raw payload
 * still has the key (eventType, Event_Type, ...), and that is not a tap.
 */
export function eventTypeOf(event: EvenHubEvent): OsEventTypeList | undefined {
  const envelope = event.textEvent ?? event.sysEvent;
  if (!envelope) return undefined;
  if (envelope.eventType !== undefined) return envelope.eventType;
  const sentType = Object.keys(event.jsonData ?? {}).some((key) => normalizeLooseKey(key) === "eventtype");
  return sentType ? undefined : OsEventTypeList.CLICK_EVENT;
}
