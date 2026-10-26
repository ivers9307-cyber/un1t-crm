// Revolut Merchant API client. Used for the car deposit flow:
//   1. createOrder() — creates an order; returns { id, token,
//      checkout_url, state, ... }. `token` is what we hand to the
//      Web SDK (createCardField) to mount the inline card field.
//      `checkout_url` is the hosted-page fallback.
//   2. getOrder() — server-side check after a buyer returns from
//      the checkout, before we trust the webhook to land.
//   3. refundOrder() — manual goodwill refunds (the deposit T&Cs
//      say non-refundable, but we still want the capability).
//      Note: refunds create a NEW order with type='refund' linked
//      via related_order_id; the original order stays 'completed'.
//   4. verifyWebhookSignature() — HMAC-SHA256 validation of the
//      `Revolut-Signature` header on incoming webhook POSTs.
//
// Auth: Bearer <secret>. Same shape for sandbox and prod, just
// different keys + base URL.
//
// All field names + enum values verified against
// https://github.com/revolut-engineering/revolut-openapi
//   yaml/merchant-2026-03-12.yaml (the version pinned in the
//   Revolut-Api-Version header). Order.state values are LOWERCASE.
//   capture_mode values are LOWERCASE ('automatic' / 'manual').

import { createHmac, timingSafeEqual } from 'node:crypto'
import { logWarn } from './log'

// API version pinned by header — Revolut requires this on every
// request. Updating the date string is the migration path when they
// release breaking changes.
const DEFAULT_API_VERSION = '2026-03-12'

function getConfig() {
  const apiKey = process.env.REVOLUT_API_KEY
  // Default to sandbox so a forgotten env var fails safely (sandbox
  // can't move real money even if the key is wrong).
  const baseUrl = process.env.REVOLUT_API_BASE_URL || 'https://sandbox-merchant.revolut.com'
  const webhookSecret = process.env.REVOLUT_WEBHOOK_SECRET
  const apiVersion = process.env.REVOLUT_API_VERSION || DEFAULT_API_VERSION
  if (!apiKey) {
    throw new Error(
      'REVOLUT_API_KEY is not configured. Set it in environment variables. ' +
      'Sandbox keys: Revolut Business sandbox dashboard → APIs → Merchant API. ' +
      'Production keys: live Business dashboard → same path.'
    )
  }
  return { apiKey, baseUrl, webhookSecret, apiVersion }
}

export class RevolutError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]  HTTP status, or 504 for a timeout / 502 for no reply
   * @param {string} [code]    'timeout' | 'network' when Revolut never answered
   *   (outcome unknown for a POST); undefined for an HTTP error answer
   */
  constructor(message, status, code) {
    super(message)
    this.name = 'RevolutError'
    this.status = status
    if (code) this.code = code
  }
}

// REVPAY.1 — transport limits. A hung Revolut call used to hold a webhook or a
// staff refund until Vercel killed the function. Every call now has a per-
// attempt timeout, and a GET (a read, safe to repeat) is retried on 429/5xx/no
// reply. A POST is NEVER retried here: a refund or order POST that answered
// 5xx or timed out may well have landed, so its outcome is unknown and the
// caller decides (the refund route retries only under the same
// Idempotency-Key, which Revolut dedupes).
export const REVOLUT_TIMEOUT_MS = 15_000
const GET_RETRIES = 2
const RETRY_BASE_MS = 300
const RETRY_AFTER_CAP_MS = 2_000
// The whole GET, retries and waits included, stays inside this, so a webhook
// that reads an order finishes well within the function's limit.
const GET_TOTAL_BUDGET_MS = 25_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

// Retry-After is seconds or an HTTP date; capped so a long hint never stalls a
// webhook. Unreadable → null (the caller uses its own backoff).
function retryAfterMs(res) {
  const raw = res?.headers?.get?.('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(raw).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(ms, RETRY_AFTER_CAP_MS)
}

function isTimeoutError(e) {
  return e?.name === 'TimeoutError' || e?.name === 'AbortError'
}

/**
 * @param {string} path
 * @param {object} [opts]
 * @param {'GET'|'POST'} [opts.method='GET']
 * @param {object} [opts.body]
 * @param {string} [opts.idempotencyKey]  sent as Idempotency-Key
 * @param {number} [opts.timeoutMs]  per-attempt timeout (default REVOLUT_TIMEOUT_MS)
 * @param {number} [opts.retries]    GET only: extra attempts (default 2); ignored for POST
 */
async function request(path, {
  method = 'GET',
  body = undefined,
  idempotencyKey = undefined,
  timeoutMs = REVOLUT_TIMEOUT_MS,
  retries = GET_RETRIES,
} = {}) {
  const { apiKey, baseUrl, apiVersion } = getConfig()
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Revolut-Api-Version': apiVersion,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const isRead = method === 'GET' || method === 'HEAD'
  const maxAttempts = isRead ? 1 + Math.max(0, Math.floor(Number(retries) || 0)) : 1
  const deadline = Date.now() + (isRead ? Math.max(GET_TOTAL_BUDGET_MS, timeoutMs) : timeoutMs)

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now()
    const attemptTimeout = Math.max(1, Math.min(timeoutMs, remaining))
    const backoff = RETRY_BASE_MS * 2 ** (attempt - 1)
    let res
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(attemptTimeout),
      })
    } catch (e) {
      const err = isTimeoutError(e)
        ? new RevolutError(`Revolut API timed out after ${attemptTimeout}ms`, 504, 'timeout')
        : new RevolutError(`Revolut API unreachable: ${e?.message || 'network error'}`, 502, 'network')
      if (attempt < maxAttempts && deadline - Date.now() > backoff + 1000) {
        await sleep(backoff)
        continue
      }
      throw err
    }

    if (!res.ok && attempt < maxAttempts && isRetryableStatus(res.status)) {
      const wait = retryAfterMs(res) ?? backoff
      if (deadline - Date.now() > wait + 1000) {
        // Drain the body so the connection is released before retrying.
        try { await res.text() } catch { /* ignore */ }
        await sleep(wait)
        continue
      }
    }

    // Revolut returns JSON on both success + error. Error shape:
    //   { code: number, message: string, errorId: string }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {
      // Non-JSON body — keep going so we can still surface the status.
    }
    if (!res.ok) {
      const message = json?.message || json?.error || `Revolut API ${res.status}`
      throw new RevolutError(message, res.status)
    }
    return json
  }
}

/**
 * Create a Merchant order and return Revolut's representation of it.
 * The hosted-checkout URL is on `.checkout_url`; redirect the buyer
 * there to take payment.
 *
 * @param {object} args
 * @param {number} args.amount — in MINOR units (cents). €500 → 50000.
 * @param {string} [args.currency='EUR']
 * @param {string} [args.description] — shown on the checkout page.
 * @param {string} [args.captureMode='AUTOMATIC'] — 'AUTOMATIC' captures on success;
 *   'MANUAL' authorises only and requires a follow-up capture call.
 * @param {string} [args.redirectUrl] — where Revolut sends the buyer
 *   AFTER payment (success OR failure — query string carries the
 *   outcome). For deposits we send them back to /cars/deposit/<token>/return.
 * @param {object} [args.metadata] — opaque map echoed in webhooks; we
 *   stash car_id + location_id so the webhook handler doesn't need to
 *   look the order up by id alone.
 * @param {string} [args.idempotencyKey] — protect against duplicate
 *   orders on retry. Recommended; we pass deposit_token here.
 */
export async function createOrder({
  amount,
  currency = 'EUR',
  description,
  // captureMode left undefined by default — the Revolut API defaults
  // to automatic capture, and the enum value has shifted between API
  // versions ('AUTOMATIC' upper-snake on older, lowercase on newer).
  // Sending the wrong casing throws 'Invalid capture mode'. Omitting
  // the field sidesteps the compatibility issue entirely. Pass an
  // explicit value only if you want manual capture (auth-only).
  captureMode,
  redirectUrl,
  metadata,
  idempotencyKey,
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RevolutError('createOrder: amount must be a positive integer in minor units', 400)
  }
  const body = {
    amount: Math.round(amount),
    currency,
  }
  if (captureMode) body.capture_mode = captureMode
  if (description) body.description = description
  if (redirectUrl) body.redirect_url = redirectUrl
  if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata
  return request('/api/orders', { method: 'POST', body, idempotencyKey })
}

/**
 * Read an order. A GET: retried on 429/5xx/no reply inside a bounded budget.
 * @param {string} orderId
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 */
export async function getOrder(orderId, opts = {}) {
  return request(`/api/orders/${encodeURIComponent(orderId)}`, opts)
}

/**
 * Issue a refund against an existing order. Omit `amount` for a full
 * refund; supply `amount` (minor units) for partial.
 *
 * REVPAY.1 — `idempotencyKey` is sent as the Idempotency-Key header, which
 * POST /api/orders/{id}/refund accepts (merchant-2026-03-12 and 2026-08-17):
 * a repeat with the same key gets the first refund back instead of a second
 * one. Never retried in the transport (a POST); a timeout surfaces as
 * RevolutError code 'timeout', outcome unknown.
 */
export async function refundOrder(orderId, { amount, currency = 'EUR', description, idempotencyKey, timeoutMs } = {}) {
  const body = {}
  if (Number.isFinite(amount)) body.amount = Math.round(amount)
  body.currency = currency
  if (description) body.description = description
  return request(`/api/orders/${encodeURIComponent(orderId)}/refund`, { method: 'POST', body, idempotencyKey, timeoutMs })
}

/**
 * Verify a webhook signature header. Revolut sends:
 *   Revolut-Signature: v1=<hex>,v1=<hex>...
 *   Revolut-Request-Timestamp: <unix-millis>
 *
 * Signed payload is `v1.<timestamp>.<raw_body>`, HMAC-SHA256'd with
 * the webhook signing secret. Multiple signatures may be present
 * during a secret rotation; any one matching is acceptable.
 *
 * Each webhook configured in Revolut has its OWN signing secret.
 * Pass `secrets` to verify against a list (e.g. the race-payments
 * handler passes `[REVOLUT_RACE_WEBHOOK_SECRET, REVOLUT_WEBHOOK_SECRET]`
 * so it works whether the env split has happened yet or not). Empty
 * / undefined entries are skipped.
 *
 * @param {string} rawBody  — the request body string EXACTLY as received
 * @param {string} signatureHeader — value of `revolut-signature`
 * @param {string} timestampHeader — value of `revolut-request-timestamp`
 * @param {object} [opts]
 * @param {string|string[]} [opts.secrets] — one or more secrets to try.
 *   Defaults to `[REVOLUT_WEBHOOK_SECRET]` for back-compat with the
 *   cars deposit webhook.
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader, opts = {}) {
  const candidateSecrets = []
  if (opts.secrets) {
    const arr = Array.isArray(opts.secrets) ? opts.secrets : [opts.secrets]
    for (const s of arr) if (s) candidateSecrets.push(s)
  }
  if (candidateSecrets.length === 0) {
    const { webhookSecret } = getConfig()
    if (webhookSecret) candidateSecrets.push(webhookSecret)
  }
  if (candidateSecrets.length === 0) {
    logWarn('revolut-webhook', 'no signing secret configured — rejecting all hooks')
    return false
  }
  if (!signatureHeader || !timestampHeader) return false

  // Optional staleness guard — reject anything older than 5 minutes
  // to limit replay window.
  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return false
  const ageMs = Math.abs(Date.now() - ts)
  if (ageMs > 5 * 60 * 1000) return false

  // Header is comma-separated `v1=<hex>` candidates. Any match wins.
  const headerCandidates = signatureHeader.split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('v1='))
    .map(s => s.slice(3))

  // Try each configured secret against each header candidate. Cross-
  // product is fine — usually 1×1 or 2×1.
  for (const secret of candidateSecrets) {
    const signedPayload = `v1.${timestampHeader}.${rawBody}`
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex')
    for (const candidate of headerCandidates) {
      try {
        const a = Buffer.from(expected, 'hex')
        const b = Buffer.from(candidate, 'hex')
        if (a.length === b.length && timingSafeEqual(a, b)) return true
      } catch {
        // Malformed candidate — try the next one.
      }
    }
  }
  return false
}

/**
 * Retrieve one dispute (chargeback) by id — `GET /api/disputes/{dispute_id}`.
 * The dispute webhook carries only `{ event, dispute_id }`; this is the
 * authoritative read. Shape (merchant-2026-03-12 spec, `Dispute`): `id`,
 * `state` (needs_response | under_review | won | lost), `substate`,
 * `created_at`, `updated_at`, `response_due_date`, `reason_code`,
 * `reason_description`, `amount` (minor units), `currency`,
 * `payment: { id, order_id, created_at, arn, amount, currency, payment_method }`.
 * REVPAY.4.
 */
export async function getDispute(disputeId) {
  return request(`/api/disputes/${encodeURIComponent(disputeId)}`)
}
