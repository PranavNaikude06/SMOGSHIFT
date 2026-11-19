// Fixed-window, in-memory rate limiter keyed by client IP.
// shortcut: per-process memory, so limits reset on restart and aren't shared across instances; fine for one Render instance.

const DEFAULT_MAX_KEYS = 10_000;

/**
 * @param {{ limit: number, windowMs: number, now?: () => number, maxKeys?: number }} options
 * @returns {{ check: (key: string) => { allowed: boolean, retryAfterSec?: number }, size: () => number }}
 */
export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = DEFAULT_MAX_KEYS }) {
  const windows = new Map(); // key → { start, count }

  const prune = (t) => {
    for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
  };

  function check(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (!w && windows.size >= maxKeys) prune(t);
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    if (w.count >= limit) {
      return { allowed: false, retryAfterSec: Math.ceil((w.start + windowMs - t) / 1000) };
    }
    w.count += 1;
    return { allowed: true };
  }

  return { check, size: () => windows.size };
}
