/** Shared HTTP helpers for the open-data feed: one User-Agent, timeouts, size limits and typed errors. */

export type Fetch = typeof fetch;

/** A descriptive agent with no personal data, as the public services ask for. */
export const USER_AGENT = "g2-hud (open source)";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** From the Retry-After header, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type Options = { timeoutMs?: number; maxBytes?: number; method?: string; headers?: Record<string, string>; body?: string };

/** Seconds ("120") or an HTTP date; anything else is ignored. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Sends the request and throws `HttpError` unless the answer is 2xx. The caller must read or cancel the body. */
export async function send(fetchFn: Fetch, url: string, options: Options = {}): Promise<Response> {
  const res = await fetchFn(url, {
    method: options.method ?? "GET",
    headers: { "User-Agent": USER_AGENT, ...options.headers },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    redirect: "follow",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}`, retryAfterMs(res.headers.get("retry-after")));
  }
  return res;
}

/** Reads a body as text and stops when it is larger than `maxBytes`. */
export async function readText(res: Response, maxBytes: number): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`response too large (${length} bytes)`);
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function getJson(fetchFn: Fetch, url: string, options: Options = {}): Promise<unknown> {
  const res = await send(fetchFn, url, { ...options, headers: { Accept: "application/json", ...options.headers } });
  return JSON.parse(await readText(res, options.maxBytes ?? 4 * 1024 * 1024));
}
