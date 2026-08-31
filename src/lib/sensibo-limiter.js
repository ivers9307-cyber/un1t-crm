// SENSIBO-RATE.1 — call spacing + 429 retry for the Sensibo API.
//
// WHY THIS EXISTS (measured against the live API on 2026-08-31):
// Sensibo rate-limits on BURSTS, not on volume.
//   ~4 requests inside ~1.6s -> 429, and the block persists >75s
//   1 request every 10s      -> 12/12 clean, ~130ms each
// So "call Sensibo less often overall" is the wrong fix; "never fire
// two Sensibo calls back-to-back" is the right one.
//
// What went wrong without it: ac-auto-off loops expired sessions
// sequentially, and each row did a GET + a POST with nothing in
// between. One trip left rows in 'failed', which the next tick
// re-picked ALONGSIDE the live rows — a bigger burst, tripping it
// again. Self-reinforcing: gym-floor AC missed its auto-off from
// 2026-08-29 and never recovered on its own. ThinQ (LG) devices on
// the very same cron were untouched throughout, which is what ruled
// out infra and pointed here.
//
// ── SCOPE, AND WHY THE CRON STAGGER IS ALSO REQUIRED ──────────────
// This queue is MODULE-LEVEL, so it only spaces calls inside a
// single serverless invocation. That covers the dominant burst (one
// cron looping many rows). It CANNOT coordinate ac-auto-off,
// ac-external-rule and class-climate with each other — those are
// separate invocations on separate instances. That is why
// vercel.json staggers those three onto different minutes. The two
// fixes are complementary; neither is sufficient alone. The 429
// retry below is the third layer, for whatever still collides.

/** Minimum gap between any two Sensibo requests from one instance. */
export const MIN_INTERVAL_MS = 1500
/** 429s come back in ~40ms, so retrying them is nearly free. */
export const MAX_RETRIES = 2
/** A timeout burns a full request timeout, so it gets a tighter budget. */
export const MAX_TIMEOUT_RETRIES = 1
export const RETRY_BASE_MS = 1500
export const JITTER_MS = 500

/**
 * Is this error Sensibo pushing back on our request rate?
 *
 * Three signals, because the same root cause surfaces three ways:
 *   - an explicit 429 status
 *   - Sensibo's "API Limit exceeded" wording (arrives with status 0
 *     when our own abort fires first)
 *   - a request timeout — under deeper burst Sensibo stops answering
 *     rather than 429ing. Prod recorded "aborted due to timeout" for
 *     exactly this cause, so treating a timeout as flaky-network and
 *     giving up would be reading the wrong story.
 */
export function isRateLimitError(err) {
  if (!err) return false
  if (err.status === 429) return true
  const msg = String(err.message || '')
  if (/api limit exceeded/i.test(msg)) return true
  if (/aborted due to timeout|timeouterror|the operation was aborted/i.test(msg)) return true
  return false
}

function isTimeoutError(err) {
  return /aborted due to timeout|timeouterror|the operation was aborted/i.test(
    String(err?.message || '')
  )
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Build a limiter. Everything injectable so tests stay deterministic
 * and instant — the defaults are what production uses.
 *
 * schedule(fn) queues fn behind every previously-scheduled call,
 * guarantees at least minIntervalMs between the START of one call
 * and the next, and retries rate-limit failures with jittered
 * backoff. It resolves/rejects with whatever fn does.
 */
export function createSensiboLimiter({
  minIntervalMs = MIN_INTERVAL_MS,
  maxRetries = MAX_RETRIES,
  maxTimeoutRetries = MAX_TIMEOUT_RETRIES,
  retryBaseMs = RETRY_BASE_MS,
  jitterMs = JITTER_MS,
  now = Date.now,
  sleep = realSleep,
  random = Math.random,
} = {}) {
  // The tail of the queue. Every schedule() chains onto it, which is
  // what serialises concurrent callers.
  let chain = Promise.resolve()
  let lastStartMs = -Infinity

  async function runWithRetry(fn) {
    let attempt = 0
    for (;;) {
      // Space this attempt off the previous request's start.
      const wait = lastStartMs + minIntervalMs - now()
      if (wait > 0) await sleep(wait)
      lastStartMs = now()
      try {
        return await fn()
      } catch (err) {
        const budget = isTimeoutError(err) ? maxTimeoutRetries : maxRetries
        if (!isRateLimitError(err) || attempt >= budget) throw err
        // Exponential backoff + jitter. Jitter matters because the AC
        // crons can still land on the same second; without it their
        // retries would collide all over again.
        const backoff = retryBaseMs * 2 ** attempt + Math.floor(random() * jitterMs)
        await sleep(backoff)
        attempt++
      }
    }
  }

  return {
    schedule(fn) {
      const result = chain.then(() => runWithRetry(fn))
      // Swallow on the CHAIN only — a rejection must not poison the
      // queue for everyone behind it. The caller still sees it via
      // `result`.
      chain = result.then(() => {}, () => {})
      return result
    },
  }
}

/**
 * The process-wide limiter every Sensibo call goes through.
 *
 * Under vitest the spacing is disabled: the suite mocks `fetch`, so
 * there is no real API to protect, and real 1.5s gaps would add
 * minutes to a suite that runs on every commit. The limiter's own
 * behaviour is covered deterministically in sensibo-limiter.test.js
 * with an injected clock, so nothing goes unverified — this only
 * stops the SINGLETON from sleeping in tests that exercise callers.
 */
export const sensiboLimiter = createSensiboLimiter(
  process.env.VITEST ? { minIntervalMs: 0, retryBaseMs: 0, jitterMs: 0 } : {}
)
