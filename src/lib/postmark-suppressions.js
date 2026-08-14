// PMSUPP.1 — Postmark Suppressions API client.
//
// WHY THIS EXISTS
// Marketing email rides the `broadcast` stream, and there are two unsubscribe
// paths that were never symmetric:
//   • Postmark's own mail-client "Unsubscribe" button — Postmark suppresses the
//     address at ITS end and webhooks us (SubscriptionChange). Both systems
//     then refuse independently.
//   • OUR surfaces — /api/unsubscribe/[token], /api/preferences/[token], the
//     preference centre — wrote ONLY to our database. Nothing ever told
//     Postmark, so for those opt-outs our database was the SINGLE gate.
//
// That gate has demonstrably failed: a trigger-ordering bug (mig 544) left
// eleven contacts logged as opted out while the column the sender reads said
// "mailable", and they sailed straight through the audience filter. Postmark
// would have been the backstop — we had simply never built it. This module is
// that backstop.
//
// BEST-EFFORT BY CONTRACT. Every export catches its own errors, logs, and
// returns a shape the caller can ignore. These run as fire-and-forget side
// effects AFTER somebody's opt-out is already durable in our database
// (CLAUDE.md: "Fire-and-forget side effects run in their own try/catch and
// never block/fail the primary response"), and the daily reconciliation in
// /api/cron/consent-drift-check repairs anything a Postmark hiccup dropped. A
// throw from here would fail a customer's opt-out — the one outcome that is
// never acceptable.
//
// API SHAPE (https://postmarkapp.com/developer/api/suppressions-api):
//   create  POST /message-streams/{stream}/suppressions
//   delete  POST /message-streams/{stream}/suppressions/delete
//   list    GET  /message-streams/{stream}/suppressions/dump
// Create and delete take {"Suppressions":[{"EmailAddress":"…"}]} and answer
// with a per-address Status — Suppressed/Deleted, or Failed with a Message.
// Both cap at 50 addresses per call.

import { resolvePostmarkToken } from './postmark-token'
import { MARKETING_STREAM } from './postmark'

// Mirrors postmark.js's module-private POSTMARK_API_URL. Kept local rather
// than refactoring that file to export it: this module must stay importable
// from the consent routes without dragging the sender's surface along with it.
const POSTMARK_API_URL = 'https://api.postmarkapp.com'

// Postmark rejects a create/delete payload over 50 addresses outright.
const BATCH_LIMIT = 50

// Only OUR OWN suppressions may be lifted. See unsuppressAtPostmark.
const MANUAL = 'ManualSuppression'

/**
 * Normalise caller input to a de-duplicated list of non-empty addresses.
 * Accepts a bare string (the common case — one person clicking unsubscribe)
 * or an array (the reconciliation cron).
 *
 * De-duplication is CASE-INSENSITIVE because contacts are stored mixed-case in
 * this database (the reason the repo's equality idiom is an escaped .ilike()
 * rather than .eq()), so the same mailbox reaches here in two spellings. The
 * first spelling seen is the one sent — Postmark matches case-insensitively.
 */
function normaliseEmails(emails) {
  const list = Array.isArray(emails) ? emails : [emails]
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const email = raw.trim()
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(email)
  }
  return out
}

/**
 * Headers for a Postmark call, or null when no server token is configured.
 *
 * postmark.js's getPostmarkToken() THROWS on a missing token, which is right
 * for a transactional send (the caller wants to know the mail did not go). It
 * is wrong here: this module runs beside somebody's opt-out and must never
 * throw. Same resolver (postmark-token.js — both env var names are live in
 * prod), different failure posture.
 */
function postmarkHeaders() {
  const token = resolvePostmarkToken()
  if (!token) return null
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': token,
  }
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const errMessage = (err) => err?.message || String(err)

/**
 * POST one batch of addresses to a create/delete endpoint and fold the
 * per-address results into `acc`.
 *
 * `successStatus` is 'Suppressed' for create, 'Deleted' for delete.
 *
 * Every requested address is accounted for, in order — the result map is keyed
 * off what we SENT, not off what came back. postmark.js's sendBatch carries the
 * same rule after a batch response mis-mapping silently dropped 499 recipients:
 * a response that omits an address must read as "failed", never as "fine".
 */
async function postSuppressionBatch(url, headers, batch, successStatus, acc, label) {
  let payload
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ Suppressions: batch.map(EmailAddress => ({ EmailAddress })) }),
    })
    payload = await response.json().catch(() => null)
    if (!response.ok || !Array.isArray(payload?.Suppressions)) {
      const message = payload?.Message || `Postmark ${label} failed (HTTP ${response.status})`
      console.error(`[postmark-suppressions] ${label} failed for ${batch.length} address(es): ${message}`)
      for (const email of batch) acc.failed.push({ email, message })
      return
    }
  } catch (err) {
    const message = errMessage(err)
    console.error(`[postmark-suppressions] ${label} threw for ${batch.length} address(es): ${message}`)
    for (const email of batch) acc.failed.push({ email, message })
    return
  }

  const byEmail = new Map(
    payload.Suppressions
      .filter(s => typeof s?.EmailAddress === 'string')
      .map(s => [s.EmailAddress.toLowerCase(), s]),
  )
  for (const email of batch) {
    const result = byEmail.get(email.toLowerCase())
    if (result?.Status === successStatus) {
      acc.ok += 1
      continue
    }
    const message = result?.Message || (result ? `Postmark returned status ${result.Status}` : 'No result returned by Postmark')
    console.error(`[postmark-suppressions] ${label} did not take for ${email}: ${message}`)
    acc.failed.push({ email, message })
  }
}

/**
 * Suppress addresses on a Postmark message stream — the second, independent
 * refusal behind an opt-out recorded in our database.
 *
 * @param {string|string[]} emails
 * @param {{stream?: string}} [opts] - defaults to the marketing stream.
 * @returns {Promise<{ok: number, failed: Array<{email: string, message: string}>}>}
 *   Never throws.
 */
export async function suppressAtPostmark(emails, { stream = MARKETING_STREAM } = {}) {
  const list = normaliseEmails(emails)
  const acc = { ok: 0, failed: [] }
  if (list.length === 0) return acc

  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-suppressions] no Postmark server token configured — cannot suppress', list.length, 'address(es)')
    return { ok: 0, failed: list.map(email => ({ email, message: 'Postmark API token not configured' })) }
  }

  const url = `${POSTMARK_API_URL}/message-streams/${encodeURIComponent(stream)}/suppressions`
  for (const batch of chunk(list, BATCH_LIMIT)) {
    await postSuppressionBatch(url, headers, batch, 'Suppressed', acc, 'suppress')
  }
  return acc
}

/**
 * Read the suppressions on a stream.
 *
 * Returns `{ suppressions, error }` rather than a bare array, deliberately: a
 * caller must be able to tell "the API said nothing is suppressed" from "we
 * could not ask". Collapsing the two would let a dead API read as an empty
 * suppression list — which is exactly how a reconciliation job concludes that
 * everything is fine, and how unsuppressAtPostmark below could be fooled into
 * treating an unverifiable suppression as one of ours.
 *
 * @param {{stream?: string, suppressionReason?: string, origin?: string, emailAddress?: string}} [opts]
 *   suppressionReason ∈ HardBounce | SpamComplaint | ManualSuppression
 *   origin            ∈ Recipient | Customer | Admin
 * @returns {Promise<{suppressions: Array<Object>, error: string|null}>} Never throws.
 */
export async function listPostmarkSuppressions({ stream = MARKETING_STREAM, suppressionReason, origin, emailAddress } = {}) {
  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-suppressions] no Postmark server token configured — cannot list suppressions')
    return { suppressions: [], error: 'Postmark API token not configured' }
  }

  const params = new URLSearchParams()
  if (suppressionReason) params.set('SuppressionReason', suppressionReason)
  if (origin) params.set('Origin', origin)
  if (emailAddress) params.set('EmailAddress', emailAddress)
  const query = params.toString()
  const url = `${POSTMARK_API_URL}/message-streams/${encodeURIComponent(stream)}/suppressions/dump${query ? `?${query}` : ''}`

  try {
    const response = await fetch(url, { method: 'GET', headers })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !Array.isArray(payload?.Suppressions)) {
      const error = payload?.Message || `Postmark suppression dump failed (HTTP ${response.status})`
      console.error(`[postmark-suppressions] dump failed: ${error}`)
      return { suppressions: [], error }
    }
    return { suppressions: payload.Suppressions, error: null }
  } catch (err) {
    const error = errMessage(err)
    console.error(`[postmark-suppressions] dump threw: ${error}`)
    return { suppressions: [], error }
  }
}

/**
 * Lift a Postmark suppression on a resubscribe — and ONLY when we put it there.
 *
 * ┌─ DO NOT "SIMPLIFY" THIS INTO AN UNCONDITIONAL DELETE ────────────────────┐
 * │ It reads the existing suppression FIRST and deletes only when            │
 * │ SuppressionReason === 'ManualSuppression'.                               │
 * │                                                                          │
 * │ • SpamComplaint — the API refuses to delete it at all. Asking is a       │
 * │   guaranteed Failed status, and the person told a mailbox provider we    │
 * │   are spam; that is not ours to undo.                                    │
 * │ • HardBounce — the API DOES delete it. Postmark describes doing so as    │
 * │   "reactivating the associated bounce", i.e. the dead mailbox becomes    │
 * │   mailable again. That is precisely the defect this repo has already     │
 * │   closed twice on the database side: emailStatusNormaliseForOptIn        │
 * │   (EMAILREP.4) exists so a re-consent click cannot resurrect a           │
 * │   hard-bounced address, and NOENGSUP.1 stopped the preference centre     │
 * │   clearing email_suppressed_at for the same reason. CONSENT IS NOT       │
 * │   EVIDENCE THE MAILBOX WORKS — the click can come from a copy delivered  │
 * │   before the bounce. Deleting the suppression here would reintroduce     │
 * │   that defect through a new door, and silently.                          │
 * │                                                                          │
 * │ A bounce suppression comes off through the list-health release path,     │
 * │ which records who lifted it and why, or through Postmark itself. Never   │
 * │ through a customer's resubscribe click.                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * If the list call fails we delete NOTHING: an unverifiable reason is never
 * assumed to be ours. Failing to lift a suppression leaves someone missing
 * mail they asked for, which the next resubscribe or a human can fix;
 * reactivating a dead mailbox spends sending reputation nobody can give back.
 *
 * @param {string|string[]} emails
 * @param {{stream?: string}} [opts]
 * @returns {Promise<{ok: number, failed: Array<{email: string, message: string}>, skipped: Array<{email: string, reason: string}>}>}
 *   `skipped` carries the addresses we deliberately left suppressed, with the
 *   Postmark reason — 'NotSuppressed' when there was nothing there at all.
 *   Never throws.
 */
export async function unsuppressAtPostmark(emails, { stream = MARKETING_STREAM } = {}) {
  const list = normaliseEmails(emails)
  const acc = { ok: 0, failed: [], skipped: [] }
  if (list.length === 0) return acc

  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-suppressions] no Postmark server token configured — cannot lift', list.length, 'suppression(s)')
    return { ok: 0, failed: list.map(email => ({ email, message: 'Postmark API token not configured' })), skipped: [] }
  }

  // One dump for the whole call. A single address (the resubscribe click, by
  // far the common case) filters server-side so the response stays small
  // instead of pulling the stream's entire bounce history down the wire.
  const { suppressions, error } = await listPostmarkSuppressions({
    stream,
    emailAddress: list.length === 1 ? list[0] : undefined,
  })
  if (error) {
    console.error(`[postmark-suppressions] refusing to lift ${list.length} suppression(s) — could not read their reason: ${error}`)
    return { ok: 0, failed: list.map(email => ({ email, message: `Could not verify suppression reason: ${error}` })), skipped: [] }
  }

  const reasonByEmail = new Map(
    suppressions
      .filter(s => typeof s?.EmailAddress === 'string')
      .map(s => [s.EmailAddress.toLowerCase(), s.SuppressionReason]),
  )

  const deletable = []
  for (const email of list) {
    const reason = reasonByEmail.get(email.toLowerCase())
    if (reason === MANUAL) {
      deletable.push(email)
      continue
    }
    // No row = nothing to lift. Reported rather than counted as a success so a
    // caller can never read "ok" as "we deleted something".
    acc.skipped.push({ email, reason: reason || 'NotSuppressed' })
  }

  if (deletable.length > 0) {
    const url = `${POSTMARK_API_URL}/message-streams/${encodeURIComponent(stream)}/suppressions/delete`
    for (const batch of chunk(deletable, BATCH_LIMIT)) {
      await postSuppressionBatch(url, headers, batch, 'Deleted', acc, 'unsuppress')
    }
  }
  return acc
}
