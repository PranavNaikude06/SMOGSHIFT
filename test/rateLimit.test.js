import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rateLimit.js';

test('allows up to the limit per window, then blocks with a retry time', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  clock = 15_000;
  assert.deepEqual(limiter.check('a'), { allowed: false, retryAfterSec: 45 });
});

test('a new window resets the count', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
  limiter.check('a');
  assert.equal(limiter.check('a').allowed, false);
  clock = 1000;
  assert.equal(limiter.check('a').allowed, true);
});

test('keys are counted separately', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('b').allowed, true);
  assert.equal(limiter.check('a').allowed, false);
});

test('expired keys are pruned so memory stays bounded', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock, maxKeys: 2 });
  limiter.check('a');
  limiter.check('b');
  clock = 2000;
  limiter.check('c');
  assert.equal(limiter.size(), 1);
});
