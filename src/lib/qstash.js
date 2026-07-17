// QStash integration (QSTASH.1 — pilot: push delivery for the
// postmark_webhook_queue).
//
// QStash is a managed HTTP message queue: we POST it a message, it
// POSTs our worker route with retries/backoff/DLQ. This lib owns both
// sides:
//
//   publishQueuePush()      — enqueue-side, called fire-and-forget after a
//                             queue-table insert. Env-gated on QSTASH_TOKEN:
//                             unset (deliberate — pre-account deploys, local
//                             dev, or kill switch) means it reports skipped
//                             and the drain cron remains the only consumer.
//                             NEVER throws — push is an optimisation; the
//                             cron is the delivery guarantee.
//
//   verifyQStashSignature() — worker-side auth. QStash signs each delivery
//                             with an HS256 JWT (`Upstash-Signature` header)
//                             whose `body` claim is the base64url sha256 of
//                             the raw request body. Verified against both
//                             signing keys so Upstash-side key rotation
//                             (current→next) never drops deliveries. We
//                             deliberately ignore the token's `alg` header —
//                             the only accepted algorithm is HMAC-SHA256 —
//                             so alg-confusion attacks are structurally
//                             impossible.

import crypto from 'node:crypto'
import { getAppUrl } from './app-url.js'

export const POSTMARK_WORKER_PATH = '/api/webhooks/qstash/postmark'

const QSTASH_PUBLISH_BASE = 'https://qstash.upstash.io/v2/publish/'

/** Allowance for clock drift between Upstash and Vercel, in seconds. */
const CLOCK_TOLERANCE_SEC = 30

export function qstashEnabled() {
  return Boolean(process.env.QSTASH_TOKEN)
}

/**
 * Publish a message to QStash for delivery to one of our worker routes.
 *
 * @param {object} opts
 * @param {string} opts.path — worker route path (e.g. POSTMARK_WORKER_PATH)
 * @param {object} opts.body — JSON payload delivered to the worker
 * @param {string} [opts.deduplicationId] — QStash-side dedup key
 * @returns {Promise<{ok: true, messageId: string} | {ok: false, skipped?: true, error?: string}>}
 */
export async function publishQueuePush({ path, body, deduplicationId }) {
  if (!qstashEnabled()) return { ok: false, skipped: true }

  try {
    const destination = `${getAppUrl()}${path}`
    const headers = {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    }
    if (deduplicationId) headers['Upstash-Deduplication-Id'] = deduplicationId

    const resp = await fetch(`${QSTASH_PUBLISH_BASE}${destination}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.error(`[qstash] publish to ${path} failed: HTTP ${resp.status}`)
      return { ok: false, error: `qstash_${resp.status}` }
    }
    const data = await resp.json()
    return { ok: true, messageId: data?.messageId }
  } catch (err) {
    console.error(`[qstash] publish to ${path} failed:`, err?.message || err)
    return { ok: false, error: err?.message || 'publish_failed' }
  }
}

function b64urlNoPad(value) {
  return value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Verify a QStash delivery signature (`Upstash-Signature` header).
 *
 * @param {object} opts
 * @param {string|null} opts.signature — the header value (HS256 JWT)
 * @param {string} opts.rawBody — the raw request body EXACTLY as delivered
 * @param {string} [opts.url] — expected destination URL; when set, the
 *   token's `sub` claim must match it exactly
 * @param {number} [opts.now] — ms epoch, injectable for tests
 * @returns {{ok: true, matched: 'current'|'next'} | {ok: false, reason: string}}
 */
export function verifyQStashSignature({ signature, rawBody, url, now = Date.now() }) {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY
  if (!currentKey && !nextKey) return { ok: false, reason: 'missing_keys' }
  if (!signature) return { ok: false, reason: 'missing_signature' }

  const parts = signature.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [headerPart, payloadPart, sigPart] = parts

  let claims
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const signingInput = `${headerPart}.${payloadPart}`
  let matched = null
  for (const [label, key] of [['current', currentKey], ['next', nextKey]]) {
    if (!key) continue
    const expected = crypto.createHmac('sha256', key).update(signingInput).digest('base64url')
    if (timingSafeEqualStr(expected, sigPart)) {
      matched = label
      break
    }
  }
  if (!matched) return { ok: false, reason: 'bad_signature' }

  const nowSec = Math.floor(now / 1000)
  if (typeof claims.exp === 'number' && nowSec > claims.exp + CLOCK_TOLERANCE_SEC) {
    return { ok: false, reason: 'expired' }
  }
  if (typeof claims.nbf === 'number' && nowSec < claims.nbf - CLOCK_TOLERANCE_SEC) {
    return { ok: false, reason: 'not_yet_valid' }
  }

  // Body integrity: the token's `body` claim is the sha256 of the delivered
  // body. Tolerate padded base64 vs base64url (QStash has emitted both).
  const expectedBody = crypto.createHash('sha256').update(rawBody ?? '').digest('base64url')
  const claimedBody = b64urlNoPad(String(claims.body || ''))
  if (claimedBody !== expectedBody) return { ok: false, reason: 'body_mismatch' }

  if (url && claims.sub !== url) return { ok: false, reason: 'url_mismatch' }

  return { ok: true, matched }
}
