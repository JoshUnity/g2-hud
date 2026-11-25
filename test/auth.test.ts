import { describe, expect, it } from "vitest";
import { MIN_TOKEN_LENGTH, handshakeProblem, requireToken } from "../server/auth";

const TOKEN = "0123456789abcdef0123456789abcdef";
const LAN = "192.0.2.10:5173";

describe("requireToken", () => {
  it("refuses a missing or short token and says how to make one", () => {
    expect(() => requireToken(undefined)).toThrow(/openssl rand -hex 24/);
    expect(() => requireToken("")).toThrow(/not set/);
    expect(() => requireToken("x".repeat(MIN_TOKEN_LENGTH - 1))).toThrow(/too short/);
  });
  it("never puts the token in the message", () => {
    const short = "secret-shortkey";
    expect(() => requireToken(short)).toThrow();
    try {
      requireToken(short);
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
  });
  it("accepts a token of the minimum length", () => {
    expect(requireToken(TOKEN)).toBe(TOKEN);
    expect(requireToken("y".repeat(MIN_TOKEN_LENGTH))).toHaveLength(MIN_TOKEN_LENGTH);
  });
});

describe("handshakeProblem", () => {
  const url = (k?: string, app = "code") => `/ws?app=${app}${k === undefined ? "" : `&k=${encodeURIComponent(k)}`}`;

  it("refuses a handshake with no key, from any origin", () => {
    expect(handshakeProblem(TOKEN, { url: url(), origin: `http://${LAN}`, host: LAN })).toBe("no pairing key");
    expect(handshakeProblem(TOKEN, { url: "/ws", origin: undefined, host: LAN })).toBe("no pairing key");
    expect(handshakeProblem(TOKEN, { url: undefined, origin: undefined, host: undefined })).toBe("no pairing key");
  });
  it("refuses a wrong key, including a prefix of the right one", () => {
    expect(handshakeProblem(TOKEN, { url: url("nope"), origin: undefined, host: LAN })).toBe("wrong pairing key");
    expect(handshakeProblem(TOKEN, { url: url(TOKEN.slice(0, -1)), origin: undefined, host: LAN })).toBe("wrong pairing key");
    expect(handshakeProblem(TOKEN, { url: url(TOKEN + "0"), origin: undefined, host: LAN })).toBe("wrong pairing key");
  });
  it("accepts the right key from the page origin, through the proxy or on localhost", () => {
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: `http://${LAN}`, host: LAN })).toBeNull();
    expect(handshakeProblem(TOKEN, { url: url(TOKEN, "hackos"), origin: "http://localhost:5173", host: "localhost:5173" })).toBeNull();
    expect(handshakeProblem(TOKEN, { url: `/ws?k=${TOKEN}`, origin: "http://LOCALHOST:5173", host: "LocalHost:5173" })).toBeNull();
  });
  it("accepts the right key with no Origin (not a browser)", () => {
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: undefined, host: "127.0.0.1:8787" })).toBeNull();
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: "", host: "127.0.0.1:8787" })).toBeNull();
  });
  it("refuses the right key from a page on another origin", () => {
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: "https://evil.example", host: LAN })).toBe("foreign origin");
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: "http://192.0.2.10:8080", host: LAN })).toBe("foreign origin");
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: "null", host: LAN })).toBe("foreign origin");
    expect(handshakeProblem(TOKEN, { url: url(TOKEN), origin: "http://evil.example", host: undefined })).toBe("foreign origin");
  });
});
