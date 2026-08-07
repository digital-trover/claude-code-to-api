/**
 * Admission control.
 *
 * Every metered turn spawns a `claude` subprocess holding hundreds of megabytes,
 * so unbounded concurrency is an out-of-memory kill rather than a slowdown. The
 * concurrency gate is the load-bearing limit here; the rate limiter is a
 * fairness control on top of it.
 */
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

const tooManyRequests = (message: string, retryAfterSeconds: number): ApiError =>
  new ApiError(429, 'rate_limit_error', message, retryAfterSeconds);

/**
 * Bounded concurrency with a bounded queue.
 *
 * Queueing rather than rejecting immediately smooths bursts, but the queue is
 * capped: an unbounded one just converts a memory problem into a latency
 * problem, with every caller timing out instead of some succeeding.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return () => this.release();
    }

    if (this.waiting.length >= this.maxQueued) {
      throw tooManyRequests(
        `server is at capacity (${this.maxConcurrent} concurrent, ${this.maxQueued} queued)`,
        Math.ceil(this.queueTimeoutMs / 1000),
      );
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiting.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(
          tooManyRequests('timed out waiting for a slot', Math.ceil(this.queueTimeoutMs / 1000)),
        );
      }, this.queueTimeoutMs);

      this.waiting.push({ resolve, reject, timer });
    });

    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }
}

/**
 * Token bucket, keyed per caller.
 *
 * Keys are hashed: this map would otherwise hold every caller's Claude
 * credential in memory for as long as the process lives.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.refillPerMs = perMinute / 60_000;
  }

  static keyFor(credentialToken: string | undefined, fallback: string): string {
    const source = credentialToken ?? fallback;
    return createHash('sha256').update(source).digest('base64url').slice(0, 16);
  }

  /** Throws a 429 when the caller is over budget. */
  take(key: string): void {
    if (this.perMinute <= 0) return;

    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: now };

    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const waitMs = (1 - bucket.tokens) / this.refillPerMs;
      throw tooManyRequests(
        `rate limit exceeded (${this.perMinute}/min)`,
        Math.max(1, Math.ceil(waitMs / 1000)),
      );
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
  }

  /** Drops buckets that have fully refilled, so idle callers are not retained. */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs;
      if (refilled >= this.burst) this.buckets.delete(key);
    }
  }
}
