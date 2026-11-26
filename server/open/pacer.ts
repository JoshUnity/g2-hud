/**
 * Decides when a source may be asked again: a minimum gap between requests, and a longer wait after
 * failures (doubling, capped). A server's Retry-After wins when it asks for more.
 */
export class Pacer {
  private nextAt = 0;
  private failures = 0;

  constructor(
    private readonly minGapMs: number,
    private readonly maxWaitMs: number,
  ) {}

  due(now: number): boolean {
    return now >= this.nextAt;
  }

  /** Call when a request starts, so a slow answer cannot cause a second request early. */
  started(now: number): void {
    this.nextAt = now + this.minGapMs;
  }

  succeeded(): void {
    this.failures = 0;
  }

  /** `waitMs` forces a wait (Retry-After, or a refusal that will not clear soon). Returns the wait used. */
  failed(now: number, waitMs?: number): number {
    this.failures++;
    const backoff = Math.min(this.maxWaitMs, this.minGapMs * 2 ** Math.min(this.failures, 12));
    const wait = Math.max(backoff, waitMs ?? 0);
    this.nextAt = now + wait;
    return wait;
  }

  get failureCount(): number {
    return this.failures;
  }
}
