import { OsEventTypeList, normalizeLooseKey, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";

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

/**
 * Calls `fn` once on a system or abnormal exit, and returns the unsubscribe function. An app calls this
 * right after it gets the bridge, so an exit during the intro or while the page is built is not lost.
 */
export function onExit(bridge: EvenAppBridge, fn: () => void): () => void {
  let done = false;
  return bridge.onEvenHubEvent((event) => {
    const type = eventTypeOf(event);
    if (done || (type !== OsEventTypeList.SYSTEM_EXIT_EVENT && type !== OsEventTypeList.ABNORMAL_EXIT_EVENT)) return;
    done = true;
    fn();
  });
}
