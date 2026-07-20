// INTEG-A3 — connection health plumbing for the connections registry.
//
// channel_connections (mig 230, widened mig 418) carries a uniform hub
// status model: status ('connected' | 'action_needed' | 'error' |
// 'not_connected'), last_error, last_ok_at. Three pieces live here:
//
// - decideConnectionHealth(row) — the PURE token-expiry grading decision
//   (unit-tested, mirrors the postmark-webhook-auth predicate pattern).
//   The daily connection-health cron applies it to every active row.
//   token_expires_at is written by the weekly instagram-token-refresh
//   cron (mig 408) — this module never talks to Meta itself.
// - stampConnectionOk / stampConnectionError — tiny best-effort stamps
//   used from the live Instagram DM paths (send + inbound webhook).
//   Fire-and-forget posture: they swallow their own errors and must
//   never break the messaging path that calls them.
// - isMetaAuthError — pure classifier for "this Graph API error means
//   the stored credential is bad" (vs a transient send failure that
//   should NOT flip the connection to error).

import { createServerClient } from '@/lib/supabase'

// How close to token expiry a 'connected' row flips to 'action_needed'.
// The weekly refresh cron keeps healthy IG tokens ~53+ days out, so a
// row inside this window means at least one refresh cycle has failed.
export const EXPIRY_SOON_DAYS = 10

// The two lifecycle messages THIS module writes. Anything else in
// last_error is treated as more specific (someone/something else put it
// there) and is never overwritten or auto-cleared by the sweep.
const EXPIRY_MESSAGE_RE = /^Access token expire[sd] \d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' label for an expiry timestamp (ISO string or Date), or null. Pure. */
export function expiryDateLabel(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/** Is this last_error one of OUR expiry lifecycle messages (safe to overwrite/clear)? Pure. */
export function isExpiryLifecycleMessage(msg) {
  return typeof msg === 'string' && EXPIRY_MESSAGE_RE.test(msg)
}

/**
 * Grade one channel_connections row from its token lifecycle stamps.
 * Returns the DB patch to apply ({ status?, last_error? }) or null when
 * the row is already in the desired state — the cron applies patches
 * verbatim, so null means "no write". Pure; injectable `now` for tests.
 *
 * Rules:
 * - not_connected rows are never graded (operator never connected).
 * - No token_expires_at → no signal (e.g. a just-pasted token, which
 *   buildConnectionPatch nulls until the refresh cron restamps it).
 * - Expired → status 'error' + 'Access token expired <date>', but a more
 *   specific existing last_error is kept (status still escalates).
 * - Within EXPIRY_SOON_DAYS → 'connected' flips to 'action_needed' with
 *   'Access token expires <date>'; error/already-flagged rows are left
 *   alone (no downgrade, no message churn).
 * - Healthy runway again (token renewed) → rows we flagged (our message,
 *   or a bare action_needed) recover to 'connected' with last_error
 *   cleared; a foreign last_error means something else flagged the row,
 *   so it stays for a human.
 */
export function decideConnectionHealth(row, now = new Date()) {
  if (!row) return null
  if (row.status === 'not_connected') return null
  const label = expiryDateLabel(row.token_expires_at)
  if (!label) return null

  const remainingMs = new Date(row.token_expires_at).getTime() - now.getTime()
  const oursOrEmpty = row.last_error == null || isExpiryLifecycleMessage(row.last_error)

  if (remainingMs <= 0) {
    const msg = `Access token expired ${label}`
    const patch = {}
    if (row.status !== 'error') patch.status = 'error'
    if (oursOrEmpty && row.last_error !== msg) patch.last_error = msg
    return Object.keys(patch).length ? patch : null
  }

  if (remainingMs <= EXPIRY_SOON_DAYS * 86400000) {
    if (row.status !== 'connected') return null
    return { status: 'action_needed', last_error: `Access token expires ${label}` }
  }

  if ((row.status === 'action_needed' || row.status === 'error') && oursOrEmpty) {
    // A bare 'error' with no message has an unknown cause — don't self-heal.
    if (row.status === 'error' && row.last_error == null) return null
    return { status: 'connected', last_error: null }
  }
  return null
}

/**
 * Does this Graph API failure mean the stored credential is bad?
 * Meta shape: { error: { message, type, code, ... } } with HTTP 400/401.
 * Expired/invalid tokens come back as type 'OAuthException' / code 190.
 * Pure.
 */
export function isMetaAuthError(error, httpStatus) {
  if (httpStatus === 401) return true
  if (!error || typeof error !== 'object') return false
  if (error.type === 'OAuthException') return true
  if (Number(error.code) === 190) return true
  return false
}

/**
 * Best-effort "this connection just worked" stamp (last_ok_at = now).
 * Never throws — a failed stamp must never break the DM path.
 * @param {object|null} db  service-role client, or null to self-create
 * @param {string} connectionId
 */
export async function stampConnectionOk(db, connectionId) {
  if (!connectionId) return
  try {
    const client = db || createServerClient()
    const { error } = await client.from('channel_connections')
      .update({ last_ok_at: new Date().toISOString() })
      .eq('id', connectionId)
    if (error) console.error('[connection-health] ok-stamp failed:', error.message)
  } catch (e) {
    console.error('[connection-health] ok-stamp threw:', e?.message)
  }
}

/**
 * Best-effort "this connection's credential is broken" stamp
 * (status = 'error' + a short last_error). Call ONLY for auth-shaped
 * failures (isMetaAuthError) — transient send failures must not flip
 * the hub status. Never throws.
 */
export async function stampConnectionError(db, connectionId, message) {
  if (!connectionId) return
  try {
    const client = db || createServerClient()
    const { error } = await client.from('channel_connections')
      .update({ status: 'error', last_error: String(message || 'Unknown error').slice(0, 300) })
      .eq('id', connectionId)
    if (error) console.error('[connection-health] error-stamp failed:', error.message)
  } catch (e) {
    console.error('[connection-health] error-stamp threw:', e?.message)
  }
}
