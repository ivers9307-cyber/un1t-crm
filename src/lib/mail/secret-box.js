// src/lib/mail/secret-box.js
//
// IMAP-CONNECTOR Phase 1.1 — envelope encryption for CUSTOMER mailbox
// credentials. AES-256-GCM, key in a Vercel env var, versioned ciphertext.
//
// ── Why this file exists at all ───────────────────────────────────────────
// The estate's existing precedent for a stored third-party secret is
// PLAINTEXT in a service-role-only table: `xero_connections` (mig 029, which
// carries its own explicit `TODO: layer pgcrypto-based encryption later`) and
// `recon_mailboxes`, which copied that shape when the receipt-hunt engine
// needed a Gmail app password.
//
// That precedent deliberately does NOT transfer here. Those two hold OUR
// tokens for OUR accounts, and the blast radius of a leak is a re-auth we
// perform ourselves. This table holds a CUSTOMER's mailbox password, and an
// IMAP app password is total mailbox authority — read every message the
// account has ever received, and send as them, forever, from anywhere. A
// database-level disclosure that costs us a Xero reconnect would cost an
// operator their entire correspondence and their domain's reputation.
//
// So the key must not live in the database it protects. That rules out
// Supabase Vault (same blast radius as the ciphertext) and pgcrypto with a
// DB-resident key. It lives in `MAILBOX_SECRET_KEY`, a Vercel environment
// variable, and the database never sees it.
//
// ── Why AES-256-GCM, and why this exact envelope ──────────────────────────
// GCM is AEAD: the 16-byte authentication tag makes tampering a THROW rather
// than a silently-wrong plaintext. That matters more than confidentiality
// here — a flipped bit in a password column that decrypted to garbage would
// surface as "the customer's mailbox stopped authenticating", which reads as
// the customer's fault and would be chased in the wrong place for days.
// `decipher.final()` refusing is the loud, correct failure.
//
// The idiom (createCipheriv / getAuthTag / setAuthTag, node:crypto only, no
// new dependency) follows `src/lib/whatsapp-flow/crypto.js`, which is the
// existing AES-GCM file in this repo. That one is AES-128 because Meta's Flow
// protocol dictates the key size; nothing dictates ours, so it is 256.
//
// A FRESH 12-byte IV is generated per seal(). Never reuse an IV under one key:
// GCM nonce reuse is catastrophic (it leaks the XOR of two plaintexts AND the
// authentication subkey, which forgives forgery). 12 bytes is the size GCM is
// specified for — any other length forces an extra GHASH derivation step and
// buys nothing.
//
// ── Why the `v1:` prefix ──────────────────────────────────────────────────
// So the key can be rotated without a flag day. A future `v2:` can mean a new
// key, a new cipher, or a KMS-wrapped data key, and `open()` can accept both
// prefixes for as long as a re-encrypt backfill takes. Without a version
// marker, rotation means "stop the world, re-encrypt everything, deploy" —
// the exact operation nobody performs, which is how a compromised key stays
// live. Rotation procedure: docs/architecture/INTEGRATIONS.md.
//
// ── Fail CLOSED, always ───────────────────────────────────────────────────
// A missing or malformed key THROWS. There is no plaintext fallback, not even
// in development, and there must never be one: a fallback would silently
// write a customer's password to the database in the clear on the one deploy
// where the env var was forgotten, and nothing downstream could tell the
// difference afterwards. This is the one place in this codebase where the
// "never trade a silent failure for a louder one" rule points the other way —
// the louder failure here is a mailbox that will not connect until an env var
// is set, and the silent one is a plaintext credential leak. The connect UI
// is the natural place to surface it (isConfigured() exists for exactly that:
// so a route can refuse the operation up front rather than throwing mid-write).
//
// Pure: no DB, no clock, no network. Fully unit-tested.
import crypto from 'node:crypto'

/** The env var holding the base64 32-byte master key. Named, never logged. */
const KEY_ENV = 'MAILBOX_SECRET_KEY'

/** Current envelope version. Anything else is refused by open(). */
const VERSION = 'v1'

const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12  // GCM's specified nonce size
const TAG_BYTES = 16 // GCM tag

/**
 * Decode + validate the master key.
 *
 * Throws — loudly and with a message an operator can act on — when the env
 * var is missing or is not exactly 32 bytes of base64. The message names the
 * variable and the expected shape; it NEVER echoes the value, because a
 * truncated key printed into a log is still most of a key.
 *
 * Node's base64 decoder is famously lenient (it skips characters outside the
 * alphabet rather than erroring), so a typo'd key would otherwise decode to
 * *something* and only fail later as an unexplained "wrong key" on every
 * mailbox at once. The alphabet check plus the exact byte-length check turn
 * that into a startup-shaped error instead. url-safe base64 (`-`/`_`) is
 * accepted and normalised, because that is what `openssl rand -base64 32 |
 * tr` and most password managers hand back.
 *
 * @returns {Buffer} 32-byte key
 */
function readKey() {
  const raw = process.env[KEY_ENV]
  if (!raw || !String(raw).trim()) {
    throw new Error(
      `${KEY_ENV} is not set. Mailbox credentials cannot be encrypted or ` +
      `decrypted without it, and there is deliberately no plaintext fallback. ` +
      `Generate one with: openssl rand -base64 32`
    )
  }
  const normalized = String(raw).trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(
      `${KEY_ENV} is not valid base64. Expected 32 random bytes, base64 ` +
      `encoded (44 characters). Generate one with: openssl rand -base64 32`
    )
  }
  const key = Buffer.from(normalized, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${KEY_ENV} decodes to ${key.length} bytes; AES-256 requires exactly ` +
      `${KEY_BYTES}. Generate one with: openssl rand -base64 32`
    )
  }
  return key
}

/**
 * Is a usable master key present?
 *
 * For CALL SITES that want to refuse an operation up front — the connect
 * route checking before it asks an operator for a password, a health surface
 * reporting "encryption not configured" — rather than discovering it inside a
 * write. It answers only the configuration question; it proves nothing about
 * whether the key is the RIGHT key for any particular ciphertext (only a
 * successful open() proves that).
 *
 * Never throws, so it is safe in a render path.
 *
 * @returns {boolean}
 */
export function isConfigured() {
  try {
    readKey()
    return true
  } catch {
    return false
  }
}

/**
 * Encrypt `plaintext` under the master key.
 *
 * @param {string} plaintext — a mailbox password or an OAuth token. Must be a
 *   non-empty string: an empty secret is never a legitimate credential, and
 *   sealing one would store a value that authenticates against nothing while
 *   looking, in every UI and every query, exactly like a configured mailbox.
 *   Refusing at the boundary is the only place that distinction survives.
 * @returns {string} `v1:<b64 iv>:<b64 tag>:<b64 ciphertext>`
 * @throws if the key is missing/malformed, or `plaintext` is not a non-empty string
 */
export function seal(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    // Deliberately does not echo the value or its type-coerced form.
    throw new TypeError('seal() requires a non-empty string')
  }
  const key = readKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a value produced by `seal()`.
 *
 * THROWS on every failure — missing key, wrong key, tampered ciphertext,
 * unknown version, structurally malformed input. There is no "best effort"
 * mode: a caller that cannot decrypt a credential has no credential, and the
 * one thing it must never do is proceed with a half-recovered value.
 *
 * ⚠️ No error thrown here contains the plaintext, the ciphertext, or the key.
 * `resolveAuth()` (auth-strategy.js) converts these throws into a verdict
 * envelope whose `error` strings are compile-time constants, so nothing on
 * this path can ever reach a log line or an operator's screen.
 *
 * Splitting on ':' is safe: base64's alphabet does not contain a colon, so
 * the four fields cannot be ambiguous.
 *
 * @param {string} sealed
 * @returns {string} plaintext
 * @throws on any failure
 */
export function open(sealed) {
  if (typeof sealed !== 'string' || sealed.length === 0) {
    throw new TypeError('open() requires a non-empty string')
  }
  const parts = sealed.split(':')
  if (parts.length !== 4) {
    throw new Error('Malformed sealed value: expected 4 colon-separated fields')
  }
  const [version, ivB64, tagB64, dataB64] = parts
  if (version !== VERSION) {
    // Named explicitly so a rotation half-done — some rows on v1, some on a
    // future v2 — reads as "this deploy cannot read that row" rather than as
    // a corrupt database.
    throw new Error(`Unsupported sealed-value version: ${JSON.stringify(version)}`)
  }
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  // Length-check both before handing them to node: createDecipheriv throws an
  // opaque "Invalid initialization vector" for a bad IV, and setAuthTag is
  // happy to accept a short tag on some builds, which weakens the very
  // guarantee this function exists to provide.
  if (iv.length !== IV_BYTES) {
    throw new Error('Malformed sealed value: bad initialization vector')
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error('Malformed sealed value: bad authentication tag')
  }
  if (data.length === 0) {
    throw new Error('Malformed sealed value: empty ciphertext')
  }
  const key = readKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // final() is what verifies the tag — it throws "Unsupported state or unable
  // to authenticate data" on a wrong key OR any tampered byte. That throw is
  // the whole point of using an AEAD here; never catch it locally.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
