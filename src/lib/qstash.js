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
// QSTASH.3 — worker for webhook_dead_letter replay pushes (published by
// deadLetterWebhook, swept by /api/cron/webhook-replay).
export const WEBHOOK_REPLAY_WORKER_PATH = '/api/webhooks/qstash/webhook-replay'
// QSTASH.4 — worker for contact_imports queue pushes (published by the
// async path of /api/contacts/import/commit, swept by
// /api/cron/process-contact-imports).
export const CONTACT_IMPORTS_WORKER_PATH = '/api/webhooks/qstash/contact-imports'
// QSTASH.6 — worker for invoices_queue bulk-analysis pushes (published
// per row by /api/invoices-inbox/bulk-queue-analysis, swept by
// /api/cron/process-invoice-analysis). Unlike the previous jobs these
// go through a named QStash QUEUE with parallelism 2: Claude Vision OCR
// must stay rate-limit-bounded, so a 50-invoice bulk queue must never
// become 50 concurrent worker invocations.
export const INVOICE_ANALYSIS_WORKER_PATH = '/api/webhooks/qstash/invoice-analysis'
export const INVOICE_ANALYSIS_QUEUE_NAME = 'invoice-analysis'
export const INVOICE_ANALYSIS_QUEUE_PARALLELISM = 2

const QSTASH_PUBLISH_BASE = 'https://qstash.upstash.io/v2/publish/'
// Enqueue onto a named FIFO queue: /v2/enqueue/<queueName>/<destination>.
// Same headers/body as publish; delivery concurrency is the queue's
// parallelism. (Endpoint verified against @upstash/qstash 2.11.2 source.)
const QSTASH_ENQUEUE_BASE = 'https://qstash.upstash.io/v2/enqueue/'
// Queue upsert: POST { queueName, parallelism } — create or update.
const QSTASH_QUEUES_URL = 'https://qstash.upstash.io/v2/queues'

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
 * @param {string} [opts.deduplicationId] — QStash-side dedup key. DASH-ONLY:
 *   QStash 400s on colons in this header (undocumented; bitten 2026-07-17).
 * @param {number} [opts.delaySeconds] — QStash-side delivery delay
 *   (`Upstash-Delay` header). Ignored unless a finite number > 0.
 * @param {string} [opts.queueName] — QSTASH.6: when set, the message is
 *   ENQUEUED onto this named FIFO queue (`/v2/enqueue/…`) instead of
 *   plain-published — QStash then bounds delivery concurrency to the
 *   queue's parallelism. Lazy upsert: only a 404 (queue missing)
 *   triggers an `ensureQueue` followed by exactly ONE retry.
 * @param {number} [opts.queueParallelism] — parallelism used if the lazy
 *   upsert fires (defaults to 1, the QStash queue default).
 * @returns {Promise<{ok: true, messageId: string} | {ok: false, skipped?: true, error?: string}>}
 */
export async function publishQueuePush({ path, body, deduplicationId, delaySeconds, queueName, queueParallelism }) {
  if (!qstashEnabled()) return { ok: false, skipped: true }

  try {
    const destination = `${getAppUrl()}${path}`
    const headers = {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    }
    if (deduplicationId) headers['Upstash-Deduplication-Id'] = deduplicationId
    if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
      headers['Upstash-Delay'] = `${delaySeconds}s`
    }

    const endpoint = queueName
      ? `${QSTASH_ENQUEUE_BASE}${queueName}/${destination}`
      : `${QSTASH_PUBLISH_BASE}${destination}`
    const attempt = () => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Hard cap on publish time. This runs INSIDE the Postmark webhook
      // handler — a hung QStash connection must degrade to "cron delivers
      // this row", never to a slow webhook response (the CAMPAIGN.13
      // burst incident was exactly that failure mode). Fresh signal per
      // attempt so the lazy-upsert retry gets its own full budget.
      signal: AbortSignal.timeout(3000),
    })

    let resp = await attempt()
    if (queueName && resp.status === 404) {
      // Queue missing (first publish since the account/queue was
      // created or deleted). Upsert it with the intended parallelism,
      // then retry the enqueue ONCE. If the upsert fails we fall
      // through to the normal error path with the original 404 — the
      // cron sweeps the row either way.
      const upserted = await ensureQueue(queueName, queueParallelism ?? 1)
      if (upserted.ok) resp = await attempt()
    }
    if (!resp.ok) {
      // Surface QStash's own error body — a bare status is undiagnosable
      // from prod logs (the 2026-07-17 HTTP 400 taught us that).
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 300)
      } catch {
        // body unreadable — the status alone will have to do
      }
      console.error(`[qstash] publish to ${path} failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`)
      return { ok: false, error: `qstash_${resp.status}` }
    }
    const data = await resp.json()
    return { ok: true, messageId: data?.messageId }
  } catch (err) {
    console.error(`[qstash] publish to ${path} failed:`, err?.message || err)
    return { ok: false, error: err?.message || 'publish_failed' }
  }
}

/**
 * Create or update a QStash queue (QSTASH.6). `POST /v2/queues` with
 * `{ queueName, parallelism }` is an upsert — safe to call repeatedly.
 * Same contract as publishQueuePush: env-gated on QSTASH_TOKEN, NEVER
 * throws, hard 3s cap. Used lazily by publishQueuePush when an enqueue
 * 404s, and callable directly to pin a queue's parallelism up front.
 *
 * @param {string} queueName
 * @param {number} parallelism — max concurrent deliveries for the queue
 * @returns {Promise<{ok: true} | {ok: false, skipped?: true, error?: string}>}
 */
export async function ensureQueue(queueName, parallelism) {
  if (!qstashEnabled()) return { ok: false, skipped: true }

  try {
    const resp = await fetch(QSTASH_QUEUES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queueName, parallelism }),
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 300)
      } catch {
        // body unreadable — the status alone will have to do
      }
      console.error(`[qstash] queue upsert ${queueName} failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`)
      return { ok: false, error: `qstash_${resp.status}` }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[qstash] queue upsert ${queueName} failed:`, err?.message || err)
    return { ok: false, error: err?.message || 'upsert_failed' }
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
