// Tests for the Sensibo call limiter (SENSIBO-RATE.1).
//
// The limiter exists because Sensibo rate-limits on BURSTS, not on
// volume. Measured against the live API 2026-08-31:
//   ~4 requests inside ~1.6s  -> 429, and the block persists >75s
//   1 request every 10s       -> 12/12 clean, ~130ms each
//
// So the fix is spacing, not "fewer calls overall". Everything here
// is injected (clock + sleep) so the tests are deterministic and
// don't actually wait.

import { describe, it, expect, vi } from 'vitest'
import { createSensiboLimiter, isRateLimitError } from './sensibo-limiter.js'

// A controllable clock + sleep pair. `sleep` doesn't wait — it just
// advances the fake clock and records the durations we were asked
// to wait for, which is exactly what we want to assert on.
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs
  const waits = []
  return {
    now: () => nowMs,
    sleep: async (ms) => { waits.push(ms); nowMs += ms },
    advance: (ms) => { nowMs += ms },
    waits,
  }
}

describe('createSensiboLimiter — spacing', () => {
  it('runs a single call immediately, with no wait', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({ minIntervalMs: 1500, ...clock })

    const out = await limiter.schedule(async () => 'ok')

    expect(out).toBe('ok')
    expect(clock.waits).toEqual([])
  })

  it('spaces consecutive calls by minIntervalMs', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({ minIntervalMs: 1500, ...clock })

    await limiter.schedule(async () => 'a')
    await limiter.schedule(async () => 'b')
    await limiter.schedule(async () => 'c')

    // First is free; each subsequent one waits the full interval.
    expect(clock.waits).toEqual([1500, 1500])
  })

  it('does not wait when the caller was already slow enough', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({ minIntervalMs: 1500, ...clock })

    await limiter.schedule(async () => 'a')
    clock.advance(5000) // caller did other work — interval already elapsed
    await limiter.schedule(async () => 'b')

    expect(clock.waits).toEqual([])
  })

  it('serialises concurrent callers instead of letting them burst', async () => {
    // This is THE case that broke prod: ac-auto-off looping rows and
    // firing GET+POST per row with nothing in between.
    const clock = fakeClock()
    const limiter = createSensiboLimiter({ minIntervalMs: 1500, ...clock })
    const order = []

    await Promise.all([
      limiter.schedule(async () => { order.push('a') }),
      limiter.schedule(async () => { order.push('b') }),
      limiter.schedule(async () => { order.push('c') }),
    ])

    expect(order).toEqual(['a', 'b', 'c'])
    expect(clock.waits).toEqual([1500, 1500])
  })

  it('keeps the queue alive when one call throws', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({ minIntervalMs: 1500, ...clock })

    const boom = limiter.schedule(async () => { throw new Error('vendor down') })
    await expect(boom).rejects.toThrow('vendor down')

    // A rejection must not poison the chain for everyone behind it.
    await expect(limiter.schedule(async () => 'still works')).resolves.toBe('still works')
  })
})

describe('createSensiboLimiter — 429 retry', () => {
  it('retries a rate-limit error and returns the eventual success', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({
      minIntervalMs: 1500, maxRetries: 2, retryBaseMs: 1000, jitterMs: 0, ...clock,
    })
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('API Limit exceeded.'), { status: 429 }))
      .mockResolvedValueOnce('recovered')

    await expect(limiter.schedule(fn)).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
    // 1000 backoff, then a 500 top-up because the retry still has to
    // clear the 1500 min interval measured from the first attempt.
    // Retries are spaced like any other call — that's deliberate: an
    // un-spaced retry is exactly the burst we're trying to avoid.
    expect(clock.waits).toEqual([1000, 500])
  })

  it('backs off exponentially and gives up after maxRetries', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({
      minIntervalMs: 1500, maxRetries: 2, retryBaseMs: 1000, jitterMs: 0, ...clock,
    })
    const err = Object.assign(new Error('API Limit exceeded.'), { status: 429 })
    const fn = vi.fn().mockRejectedValue(err)

    await expect(limiter.schedule(fn)).rejects.toThrow('API Limit exceeded.')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
    // 1000 backoff, 500 spacing top-up, then 2000 backoff (by which
    // point the interval is already clear, so no third top-up).
    expect(clock.waits).toEqual([1000, 500, 2000])
  })

  it('does NOT retry a non-rate-limit error', async () => {
    const clock = fakeClock()
    const limiter = createSensiboLimiter({
      minIntervalMs: 1500, maxRetries: 2, retryBaseMs: 1000, jitterMs: 0, ...clock,
    })
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error('pod not found'), { status: 404 })
    )

    await expect(limiter.schedule(fn)).rejects.toThrow('pod not found')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout only once, because each attempt costs a full timeout', async () => {
    // A 429 comes back in ~40ms so retrying twice is nearly free. A
    // timeout burns the whole REQUEST_TIMEOUT_MS, and ac-auto-off
    // loops several rows inside one 60s function — so timeouts get a
    // tighter budget than 429s on purpose.
    const clock = fakeClock()
    const limiter = createSensiboLimiter({
      minIntervalMs: 0, maxRetries: 2, maxTimeoutRetries: 1,
      retryBaseMs: 1000, jitterMs: 0, ...clock,
    })
    const fn = vi.fn().mockRejectedValue(
      new Error('Sensibo network error: The operation was aborted due to timeout')
    )

    await expect(limiter.schedule(fn)).rejects.toThrow('aborted due to timeout')
    expect(fn).toHaveBeenCalledTimes(2) // initial + 1 retry, NOT 3
  })

  it('applies jitter within the configured bound', async () => {
    // Jitter matters because the three AC crons can still land on the
    // same second; without it their retries would collide again.
    const clock = fakeClock()
    const limiter = createSensiboLimiter({
      minIntervalMs: 0, maxRetries: 1, retryBaseMs: 1000, jitterMs: 500,
      random: () => 0.5, ...clock,
    })
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }))
      .mockResolvedValueOnce('ok')

    await limiter.schedule(fn)
    expect(clock.waits).toEqual([1250]) // 1000 base + 0.5 * 500 jitter
  })
})

describe('isRateLimitError', () => {
  it('recognises an explicit 429 status', () => {
    expect(isRateLimitError(Object.assign(new Error('nope'), { status: 429 }))).toBe(true)
  })

  it('recognises Sensibo\'s rate-limit wording even without a status', () => {
    // The wording arrives on a status-0 SensiboError when the abort
    // fires, so message matching is a genuine second signal here.
    expect(isRateLimitError(new Error('API Limit exceeded. Lower the request rate and try again later.'))).toBe(true)
  })

  it('treats a request timeout as rate-limiting', () => {
    // Under deeper burst Sensibo stops answering rather than 429ing —
    // prod recorded "aborted due to timeout", not 429, for the same cause.
    expect(isRateLimitError(new Error('Sensibo network error: The operation was aborted due to timeout'))).toBe(true)
  })

  it('does not treat an ordinary vendor error as rate-limiting', () => {
    expect(isRateLimitError(Object.assign(new Error('pod not found'), { status: 404 }))).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})
