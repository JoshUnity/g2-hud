import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { Fetch } from "../server/open/http";

export const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", "open", name), "utf8");
export const json = (name: string): any => JSON.parse(fixture(name));

export type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/** A fetch that never touches the network: `route` answers by URL. Every call is recorded. */
export function fakeFetch(route: (url: string, call: Call) => Response | Promise<Response>): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return route(url, call);
  }) as Fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export const ok = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers });
export const status = (code: number, headers: Record<string, string> = {}): Response => new Response("no", { status: code, headers });
export const gz = (xml: string): Response => new Response(new Uint8Array(gzipSync(xml)), { status: 200 });
