import crypto from 'node:crypto'

/**
 * Constant-time string comparison. Returns false if either input is missing
 * or lengths differ; never short-circuits on byte mismatch.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 *
 * Meta sends the header as `sha256=<hex digest>` where the digest is
 * HMAC-SHA256(rawBody, appSecret). We compute the same and compare in
 * constant time.
 *
 * @param {string} rawBody  Raw request body (must be the exact bytes Meta
 *                          sent — read once via `await request.text()` BEFORE
 *                          calling JSON.parse).
 * @param {string|null} headerValue  Value of `x-hub-signature-256`.
 * @param {string|undefined} appSecret  WhatsApp App Secret.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyMetaSignature(rawBody, headerValue, appSecret) {
  if (!appSecret) {
    return { ok: false, reason: 'missing_secret' }
  }
  if (!headerValue || !headerValue.startsWith('sha256=')) {
    return { ok: false, reason: 'missing_or_malformed_header' }
  }

  const provided = headerValue.slice('sha256='.length)
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex')

  // Both strings are hex of the same length (64 chars), so safeEqual works.
  return safeEqual(expected, provided)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' }
}

/**
 * Verify a shared-secret token sent in a header (used for Postmark webhooks
 * and any other "no native HMAC" provider). Configure the provider to send
 * a fixed token in the named header; we compare it constant-time against the
 * env var.
 *
 * @param {string|null} headerValue  Value of the configured token header.
 * @param {string|undefined} expectedSecret
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifySharedSecret(headerValue, expectedSecret) {
  if (!expectedSecret) return { ok: false, reason: 'missing_secret' }
  if (!headerValue) return { ok: false, reason: 'missing_header' }
  return safeEqual(headerValue, expectedSecret)
    ? { ok: true }
    : { ok: false, reason: 'secret_mismatch' }
}
