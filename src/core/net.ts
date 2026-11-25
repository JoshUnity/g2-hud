import { ServerMessageSchema, type ClientMessage, type ServerMessage } from "./protocol";

export type Server = {
  send: (message: ClientMessage) => void;
  sendBinary: (data: Uint8Array<ArrayBuffer>) => void;
  isOpen: () => boolean;
  /** Closes the socket for good; no reconnect. */
  close: () => void;
};

/** Shown when the page URL has no pairing key, so the server would refuse every connection. */
export const MISSING_KEY_MESSAGE = "No pairing key in the page URL. Open the app with npm run qr or npm run sim.";

/**
 * One WebSocket to the HUD server (same origin, /ws), reconnecting with backoff.
 * The pairing key comes from "k" in the page URL (put there by scripts/open.mjs) and goes
 * on the WebSocket URL. A browser cannot see the server's 401, so a page with no key at all
 * does not try: it reports MISSING_KEY_MESSAGE as an "error" message instead.
 */
export function connectServer(
  onMessage: (message: ServerMessage) => void,
  onConnected: (connected: boolean) => void,
  app?: string,
): Server {
  let socket: WebSocket | null = null;
  let closed = false;
  const params = new URLSearchParams();
  if (app) params.set("app", app);
  const key = new URLSearchParams(location.search).get("k");
  if (key) params.set("k", key);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${params}`;

  const open = (attempt: number): void => {
    if (closed) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      attempt = 0;
      onConnected(true);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = ServerMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) onMessage(parsed.data);
    });
    ws.addEventListener("close", () => {
      socket = null;
      if (closed) return;
      onConnected(false);
      setTimeout(() => open(attempt + 1), Math.min(10_000, 500 * 2 ** attempt));
    });
  };
  if (key) open(0);
  else {
    // Later, so the caller has finished its own set-up (it may use the returned object).
    setTimeout(() => {
      if (closed) return;
      onConnected(false);
      onMessage({ type: "error", message: MISSING_KEY_MESSAGE });
    }, 0);
  }
  return {
    send: (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    sendBinary: (data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    },
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
