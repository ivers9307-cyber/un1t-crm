// Lightweight Postgres-backed fixed-window rate limiter.
//
// Usage:
//   import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
//
//   export async function POST(request) {
//     const db = createServerClient()
//     const ip = getClientIp(request)
//     const limit = await checkRateLimit(db, `book:${ip}`, { max: 5, windowMs: 15 * 60_000 })
//     if (!limit.allowed) return rateLimitResponse(limit)
//     ...
//   }
//
// Backed by `rate_limit_buckets` (migration 015) and the
// `public.rate_limit_hit(key, window_start, window_ms)` RPC.
// Fail-open: if the DB call errors, we log and let the request through —
// a rate-limiter outage must not break the public booking flow.

import { NextResponse } from 'next/server'

/**
 * Extract the client IP from request headers. On Vercel, x-forwarded-for is
 * set by the proxy and the first entry is the trusted client IP. Falls back
 * to x-real-ip, then "unknown" so the limiter still functions (callers in the
 * same NAT will share a bucket — acceptable for an abuse limiter).
 *
 * @param {Request} request
 * @returns {string}
 */
export function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip') || 'unknown'
}

/**
 * @typedef {Object} RateLimitResult
 * @property {boolean} allowed       Whether this request is within the limit
 * @property {number}  remaining     Requests left in the current window (>= 0)
 * @property {Date}    resetAt       When the current window ends
 * @property {number}  retryAfterSec Seconds until the current window ends (for Retry-After)
 */

/**
 * Increment the bucket for `key` in the current fixed window and return whether
 * we're still under `max`. Window boundaries are aligned to multiples of
 * `windowMs` since the unix epoch — every IP sees the same window edges, which
 * keeps the math trivial and the bucket count bounded.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  Service-role Supabase client
 * @param {string} key   Bucket key, e.g. `"book:1.2.3.4"`. Caller is responsible for prefixing.
 * @param {{ max: number, windowMs: number }} opts
 * @returns {Promise<RateLimitResult>}
 */
export async function checkRateLimit(db, key, { max, windowMs }) {
  const now = Date.now()
  const windowStartMs = Math.floor(now / windowMs) * windowMs
  const windowStart = new Date(windowStartMs)
  const resetAt = new Date(windowStartMs + windowMs)
  const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000))

  try {
    const { data, error } = await db.rpc('rate_limit_hit', {
      p_key: key,
      p_window_start: windowStart.toISOString(),
      p_window_ms: windowMs,
    })

    if (error) {
      // Fail open — log loudly so we know if the limiter is broken.
      console.error('[rate-limit] RPC error, failing open:', error.message)
      return { allowed: true, remaining: max, resetAt, retryAfterSec }
    }

    const count = typeof data === 'number' ? data : Number(data)
    const remaining = Math.max(0, max - count)
    const allowed = count <= max

    return { allowed, remaining, resetAt, retryAfterSec }
  } catch (err) {
    console.error('[rate-limit] threw, failing open:', err?.message || err)
    return { allowed: true, remaining: max, resetAt, retryAfterSec }
  }
}

/**
 * Build a 429 NextResponse with the standard headers. Use when checkRateLimit
 * returns { allowed: false }.
 *
 * @param {RateLimitResult} result
 * @param {string} [message]
 * @returns {NextResponse}
 */
export function rateLimitResponse(result, message = 'Too many requests. Please try again shortly.') {
  return NextResponse.json(
    { success: false, error: message },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSec),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
      },
    }
  )
}
