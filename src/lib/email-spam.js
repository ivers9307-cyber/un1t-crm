// MAIL-SPAM.1 — spam quarantine for inbound mail: the pure half.
//
// WHAT THIS DECIDES
// Postmark's inbound webhook payload carries SpamAssassin's verdict on every
// message — `SpamScore` at the top level, and the `X-Spam-Status` /
// `X-Spam-Score` headers Postmark stamps before forwarding. Until this landed
// nothing read any of it: spam opened a ticket, pushed staff and lit the
// badge exactly like a member's email. This module reads the score and
// judges it against the location's threshold; the webhook applies the
// verdict (flag the ticket, skip the push and the unread bump), the list
// scopes keep quarantined rows out of every view but Spam.
//
// 🔴 EVERYTHING HERE FAILS OPEN. A lost lead is worse than a spam ticket, so
// every ambiguous input resolves to "file it normally":
//   • no readable score anywhere            → not spam (score null)
//   • filter disabled at the location        → not spam
//   • threshold unreadable / out of range    → the DEFAULT threshold, never 0
//     (a threshold of 0 would quarantine every email ever received)
// The only way a message is quarantined is a real number at or above a real
// threshold on an enabled filter.
//
// EVERYTHING HERE IS PURE. No db, no clock except as a parameter, so the
// decisions are unit-testable and the same code runs in the webhook, the
// settings route and the settings card.

import { getHeader } from './email-inbox'

/**
 * SpamAssassin's own default `required_score`, and what Postmark suggests as
 * the line. Mirrored by the column DEFAULT in mig 584; both sides carry it so
 * a location with no company_settings row still gets a filter rather than
 * silently getting none.
 */
export const DEFAULT_EMAIL_SPAM_THRESHOLD = 5

export const SPAM_THRESHOLD_MIN = 0
export const SPAM_THRESHOLD_MAX = 20

export const DEFAULT_EMAIL_SPAM_SETTINGS = Object.freeze({
  enabled: true,
  threshold: DEFAULT_EMAIL_SPAM_THRESHOLD,
})

/** The company_settings column names (mig 584), in one place. */
export const SPAM_SETTINGS_COLUMNS = Object.freeze({
  enabled: 'email_spam_filter_enabled',
  threshold: 'email_spam_threshold',
})

/** How long a still-quarantined ticket lives before the purge cron deletes it. */
export const SPAM_RETENTION_DAYS = 30

// ─── settings ─────────────────────────────────────────────────────

function thresholdOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n < SPAM_THRESHOLD_MIN || n > SPAM_THRESHOLD_MAX) return null
  return n
}

/**
 * Normalise a raw config into `{ enabled, threshold }`.
 *
 * Accepts the company_settings row shape (snake_case columns — numeric
 * columns arrive as STRINGS from PostgREST), the camelCase shape the client
 * hands back, or null/undefined for "no row at all". Every field falls back
 * INDEPENDENTLY to the default, so a half-written row can never mean "no
 * filter" or "threshold 0".
 *
 * @param {object|null} raw
 * @returns {{ enabled: boolean, threshold: number }}
 */
export function normalizeSpamSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EMAIL_SPAM_SETTINGS }

  const rawEnabled = raw[SPAM_SETTINGS_COLUMNS.enabled] ?? raw.enabled
  const enabled = rawEnabled === null || rawEnabled === undefined
    ? DEFAULT_EMAIL_SPAM_SETTINGS.enabled
    : rawEnabled === true

  const threshold = thresholdOrNull(raw[SPAM_SETTINGS_COLUMNS.threshold] ?? raw.threshold)
    ?? DEFAULT_EMAIL_SPAM_SETTINGS.threshold

  return { enabled, threshold }
}

// ─── the score ────────────────────────────────────────────────────

/**
 * What mig 584's `spam_score numeric(6,2)` can hold. A header is attacker
 * text: `X-Spam-Score: 1e300` is a finite number that overflows the column
 * (22003) → the ticket insert fails → 500 → Postmark retries the poison until
 * exhausted (the EMAIL-INBOUND-POISON.1 shape). Every score is clamped here,
 * once, before anything downstream can see it; the verdict is unaffected —
 * anything past the clamp was already far past any threshold (0–20).
 */
export const SPAM_SCORE_MIN = -999
export const SPAM_SCORE_MAX = 999

function finiteOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** finiteOrNull, clamped to the column — the only shape a score may take. */
function scoreOrNull(value) {
  const n = finiteOrNull(value)
  if (n === null) return null
  return Math.min(Math.max(n, SPAM_SCORE_MIN), SPAM_SCORE_MAX)
}

/**
 * The SpamAssassin score off a Postmark inbound payload, or null.
 *
 * Precedence: the typed `SpamScore` field, then the `X-Spam-Score` header,
 * then `score=N` parsed out of `X-Spam-Status` ("Yes, score=7.2 required=5.0
 * tests=…"). Postmark documents all three; which are present depends on the
 * stream and on whether the shim forwarded the headers, so all three are
 * read. Null — never 0 — when nothing usable is there.
 *
 * @param {object|null} body  the inbound payload
 * @returns {number|null}
 */
export function extractSpamScore(body) {
  if (!body || typeof body !== 'object') return null

  const direct = scoreOrNull(body.SpamScore)
  if (direct !== null) return direct

  const headers = Array.isArray(body.Headers) ? body.Headers : null
  if (!headers) return null

  const scoreHeader = scoreOrNull(getHeader(headers, 'X-Spam-Score'))
  if (scoreHeader !== null) return scoreHeader

  const status = getHeader(headers, 'X-Spam-Status')
  if (typeof status === 'string') {
    const m = status.match(/\bscore=(-?\d+(?:\.\d+)?)/i)
    if (m) return scoreOrNull(m[1])
  }
  return null
}

// ─── the verdict ──────────────────────────────────────────────────

/**
 * Is this message spam at this location?
 *
 * `score` is extractSpamScore's answer; `settings` is the raw company_settings
 * row (or null — most locations have none, and get the defaults).
 *
 * @param {{ score: number|null|undefined, settings: object|null }} args
 * @returns {{ isSpam: boolean, score: number|null, threshold: number, enabled: boolean }}
 */
export function classifyInboundSpam({ score, settings }) {
  const { enabled, threshold } = normalizeSpamSettings(settings)
  // Clamped here too: the webhook inserts THIS score, so a caller that skipped
  // extractSpamScore still cannot hand the column something it cannot hold.
  const n = scoreOrNull(score)
  // Fail open on every branch but the one that is unambiguously spam.
  const isSpam = enabled && n !== null && n >= threshold
  return { isSpam, score: n, threshold, enabled }
}

// ─── the purge clock ──────────────────────────────────────────────

/**
 * The ISO timestamp before which a still-quarantined ticket is purged.
 * `now` is a parameter so the cron's test is deterministic.
 */
export function spamPurgeCutoff(now = Date.now()) {
  const ms = typeof now === 'number' ? now : new Date(now).getTime()
  return new Date(ms - SPAM_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}
