import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MISSING_KEY_MESSAGE, connectServer } from "../src/core/net";
import type { ServerMessage } from "../src/core/protocol";

/** Stand-in for the browser WebSocket: records URLs, lets a test open and close sockets. */
class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function page(search: string): void {
  vi.stubGlobal("location", { protocol: "http:", host: "192.0.2.10:5173", search });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connectServer", () => {
  it("sends the pairing key from the page URL on the WebSocket URL", () => {
    page("?k=abc%2Bdef0123456789&demo=0");
    connectServer(() => undefined, () => undefined, "code");
    expect(FakeSocket.all).toHaveLength(1);
    const url = new URL(FakeSocket.all[0]!.url);
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("192.0.2.10:5173");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("app")).toBe("code");
    expect(url.searchParams.get("k")).toBe("abc+def0123456789");
  });

  it.each(["around", "sky"])("puts app=%s on the WebSocket URL, the parameter server/index.ts reads", (app) => {
    page("?k=0123456789abcdef");
    connectServer(() => undefined, () => undefined, app);
    expect(new URL(FakeSocket.all[0]!.url).searchParams.get("app")).toBe(app);
  });

  it("keeps the key on every reconnect", () => {
    page("?k=0123456789abcdef");
    const states: boolean[] = [];
    connectServer(() => undefined, (c) => states.push(c));
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(new URL(FakeSocket.all[1]!.url).searchParams.get("k")).toBe("0123456789abcdef");
    expect(new URL(FakeSocket.all[1]!.url).searchParams.has("app")).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it("reports a page with no key instead of retrying a socket the server refuses", () => {
    page("");
    const messages: ServerMessage[] = [];
    const states: boolean[] = [];
    const server = connectServer((m) => messages.push(m), (c) => states.push(c), "hackos");
    // Not reported synchronously: the caller may still be setting up.
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(0);
    expect(states).toEqual([false]);
    expect(messages).toEqual([{ type: "error", message: MISSING_KEY_MESSAGE }]);
    expect(server.isOpen()).toBe(false);
    server.send({ type: "reset" });
  });

  it("close() closes the socket and stops reconnecting", () => {
    page("?k=0123456789abcdef");
    const states: boolean[] = [];
    const server = connectServer(() => undefined, (c) => states.push(c), "answers");
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(server.isOpen()).toBe(true);
    server.close();
    expect(socket.readyState).toBe(3);
    expect(server.isOpen()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(states).toEqual([true]);
    server.send({ type: "reset" });
    expect(socket.sent).toEqual([]);
  });

  it("close() before the socket opens also stops the retry", () => {
    page("?k=0123456789abcdef");
    const server = connectServer(() => undefined, () => undefined);
    server.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
