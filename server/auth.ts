import { createHash, timingSafeEqual } from "node:crypto";

/** Shortest HUD_TOKEN the server accepts. */
export const MIN_TOKEN_LENGTH = 16;

/** Returns HUD_TOKEN, or throws with the steps to create one. Never put the token in the message. */
export function requireToken(value: string | undefined): string {
  if (!value || value.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `HUD_TOKEN is ${value ? "too short" : "not set"}. It is the pairing key every glasses page must send. ` +
        `Create one with "openssl rand -hex 24" and add HUD_TOKEN=<that value> to .env (at least ${MIN_TOKEN_LENGTH} characters).`,
    );
  }
  return value;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export type Handshake = {
  /** Request target, for example "/ws?app=code&k=...". */
  url: string | undefined;
  /** Origin header; browsers always send it, other clients may not. */
  origin: string | undefined;
  /** Host header. */
  host: string | undefined;
};

/**
 * Why a WebSocket handshake must be refused, or null to accept it.
 * The pairing key in "k" is the control. The Origin rule is a second layer: a browser page
 * may only connect to the host it was served from (the Vite proxy keeps Host and Origin).
 */
export function handshakeProblem(token: string, { url, origin, host }: Handshake): string | null {
  const key = new URL(url ?? "/", "http://localhost").searchParams.get("k") ?? "";
  // Compare digests: timingSafeEqual needs equal lengths and must not leak the token length.
  if (!timingSafeEqual(digest(key), digest(token))) return key ? "wrong pairing key" : "no pairing key";
  if (!origin) return null;
  try {
    if (new URL(origin).host === (host ?? "").toLowerCase()) return null;
  } catch {
    // An unparsable Origin, for example "null", is not same-host.
  }
  return "foreign origin";
}
