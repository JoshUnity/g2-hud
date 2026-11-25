import { AppLocationAccuracy, type AppLocation, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { metresBetween } from "./geo";
import type { ClientMessage } from "./protocol";

/** The part of the server connection this module needs. */
export type Link = { send: (message: ClientMessage) => void; isOpen: () => boolean };
/** The part of the bridge this module needs. */
export type LocationBridge = Pick<EvenAppBridge, "getAppLocation" | "startAppLocationUpdates" | "stopAppLocationUpdates" | "onAppLocationChanged">;

export type LocationReporter = {
  /** Sends the last fix again (after a reconnect). With no fix yet, asks the host for one. */
  resend: () => void;
  /** Starts the updates again (after the app returns to the foreground: the host stops them while it is suspended). */
  rearm: () => void;
  /** Stops the updates and the timer. Safe to call twice. After this, nothing is sent. */
  stop: () => void;
};

/** A move of more than this many metres is sent at once. */
export const MOVE_M = 25;
/** A fix is sent again after this long even when you stand still, so a server that restarted learns it. */
export const REPEAT_MS = 60_000;

/**
 * Tells the server where the phone is. It sends the first fix, then a fix that is more than MOVE_M from the
 * last one sent, then the last fix every REPEAT_MS. A denied permission or a missing fix sends nothing.
 */
export function startLocation(bridge: LocationBridge, link: Link): LocationReporter {
  let stopped = false;
  let last: AppLocation | null = null;
  let sent: { at: number; lat: number; lon: number } | null = null;
  let off: (() => void) | null = null;

  const valid = (fix: AppLocation | null | undefined): fix is AppLocation =>
    !!fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude) && Math.abs(fix.latitude) <= 90 && Math.abs(fix.longitude) <= 180;

  const report = (): void => {
    if (stopped || !last || !link.isOpen()) return;
    const accuracy = last.accuracy !== undefined && Number.isFinite(last.accuracy) && last.accuracy >= 0 ? last.accuracy : undefined;
    link.send({ type: "position", lat: last.latitude, lon: last.longitude, ...(accuracy === undefined ? {} : { accuracy }) });
    sent = { at: Date.now(), lat: last.latitude, lon: last.longitude };
  };

  const onFix = (fix: AppLocation | null | undefined): void => {
    if (stopped || !valid(fix)) return;
    last = fix;
    const moved = sent === null || metresBetween({ lat: sent.lat, lon: sent.lon }, { lat: fix.latitude, lon: fix.longitude }) > MOVE_M;
    if (moved || Date.now() - sent!.at >= REPEAT_MS) report();
  };

  const fetchOnce = async (): Promise<void> => {
    try {
      onFix(await bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 10_000 }));
    } catch {
      // Denied or no fix: send nothing. The app shows its "no position" state.
    }
  };

  const arm = async (): Promise<void> => {
    try {
      if (!off) off = bridge.onAppLocationChanged(onFix);
      if (stopped) return off?.();
      await bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.Medium, distanceFilter: 10, intervalMs: 5000 });
    } catch {
      // Same: updates are not available.
    }
  };

  const timer = setInterval(() => {
    if (last) report();
    else void fetchOnce();
  }, REPEAT_MS);
  void arm();
  void fetchOnce();

  return {
    resend: () => {
      if (stopped) return;
      if (last) report();
      else void fetchOnce();
    },
    rearm: () => {
      if (stopped) return;
      void arm();
      void fetchOnce();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      off?.();
      off = null;
      void Promise.resolve()
        .then(() => bridge.stopAppLocationUpdates())
        .catch(() => {});
    },
  };
}
