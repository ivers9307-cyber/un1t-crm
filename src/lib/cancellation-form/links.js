// CANCEL-FORM.3 — the issued-link ledger: cancellation_form_links (mig 585).
//
// The URL token (token.js) carries only { link id, exp }. This module is the
// map from a token to a person, and the single-use / revocation state:
//   issueLink        → one row per send (id minted here so the token can be
//                      signed and fingerprinted before the INSERT — no
//                      placeholder-then-update window)
//   resolveLink      → token → row (by id AND fingerprint) → contact, or null
//   markOpened       → first open only
//   claimLink        → atomic single-use claim (predicate on used_at IS NULL)
//   unclaimLink      → release after a failed request insert
//   attachRequest    → back-link to the agent_membership_requests row
//   revokeLink       → send failed / staff withdrew
//   latestLinkForContact → the profile chip
//
// Every reader here is a service-role route that enforces access in app code;
// RLS on the table governs the browser only (CLAUDE.md).

import crypto from 'node:crypto'
import { tokenFingerprint } from '@/lib/consent-token-guard'
import { signCancellationFormToken, verifyCancellationFormToken, CANCELLATION_FORM_TTL_DAYS } from './token'

const LINK_COLUMNS = 'id, location_id, contact_id, issued_by, issued_at, channel, token_fingerprint, expires_at, opened_at, used_at, revoked_at, send_error, conversation_id, request_id'
const CONTACT_COLUMNS = 'id, first_name, name, location_id, glofox_membership_plan'

export function buildFormUrl(baseUrl, token) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/cancel/${token}`
}

/**
 * @returns {Promise<{ok:true, linkId:string, token:string, url:string, expiresAt:string}|{ok:false, error:string}>}
 */
export async function issueLink(db, { contactId, locationId, issuedBy = null, channel, conversationId = null, baseUrl, now = Date.now() }) {
  const linkId = crypto.randomUUID()
  const token = signCancellationFormToken({ linkId, now })
  const expiresAt = new Date(now + CANCELLATION_FORM_TTL_DAYS * 86400_000).toISOString()
  const { error } = await db.from('cancellation_form_links').insert({
    id: linkId,
    location_id: locationId,
    contact_id: contactId,
    issued_by: issuedBy,
    issued_at: new Date(now).toISOString(),
    channel,
    conversation_id: conversationId,
    token_fingerprint: tokenFingerprint(token),
    expires_at: expiresAt,
  }).select('id').single()
  if (error) return { ok: false, error: error.message || 'insert failed' }
  return { ok: true, linkId, token, url: buildFormUrl(baseUrl, token), expiresAt }
}

/**
 * Token → { link, contact } or null. One null for every failure mode
 * (forged, expired, revoked, fingerprint mismatch, contact gone) so the
 * public route can answer a uniform 404.
 */
export async function resolveLink(db, token, { now = Date.now() } = {}) {
  const claim = verifyCancellationFormToken(token, { now })
  if (!claim) return null
  const fp = tokenFingerprint(token)
  const { data: link } = await db.from('cancellation_form_links')
    .select(LINK_COLUMNS)
    .eq('id', claim.linkId)
    .eq('token_fingerprint', fp)
    .maybeSingle()
  if (!link) return null
  if (link.revoked_at) return null
  const exp = Date.parse(link.expires_at || '')
  if (!Number.isFinite(exp) || exp < now) return null
  const { data: contact } = await db.from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('id', link.contact_id)
    .maybeSingle()
  if (!contact) return null
  return { link, contact }
}

export async function markOpened(db, linkId, now = new Date().toISOString()) {
  const { error } = await db.from('cancellation_form_links')
    .update({ opened_at: now, updated_at: now })
    .eq('id', linkId)
    .is('opened_at', null)
    .select('id')
  if (error) console.warn(`[cancel-form] markOpened ${linkId}: ${error.message}`)
}

/** Atomic single-use claim. True when THIS call took the link. */
export async function claimLink(db, linkId, now = new Date().toISOString()) {
  const { data, error } = await db.from('cancellation_form_links')
    .update({ used_at: now, updated_at: now })
    .eq('id', linkId)
    .is('used_at', null)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  if (error) {
    console.warn(`[cancel-form] claimLink ${linkId}: ${error.message}`)
    return false
  }
  return !!data
}

export async function unclaimLink(db, linkId) {
  const { error } = await db.from('cancellation_form_links')
    .update({ used_at: null, updated_at: new Date().toISOString() })
    .eq('id', linkId)
    .select('id')
  if (error) console.warn(`[cancel-form] unclaimLink ${linkId}: ${error.message}`)
}

export async function attachRequest(db, linkId, requestId) {
  const { error } = await db.from('cancellation_form_links')
    .update({ request_id: requestId, updated_at: new Date().toISOString() })
    .eq('id', linkId)
    .select('id')
  if (error) console.warn(`[cancel-form] attachRequest ${linkId}: ${error.message}`)
}

export async function revokeLink(db, linkId, sendError = null) {
  const now = new Date().toISOString()
  const { error } = await db.from('cancellation_form_links')
    .update({ revoked_at: now, send_error: sendError ? String(sendError).slice(0, 500) : null, updated_at: now })
    .eq('id', linkId)
    .select('id')
  if (error) console.warn(`[cancel-form] revokeLink ${linkId}: ${error.message}`)
}

export async function latestLinkForContact(db, contactId) {
  if (!contactId) return null
  const { data } = await db.from('cancellation_form_links')
    .select(LINK_COLUMNS)
    .eq('contact_id', contactId)
    .order('issued_at', { ascending: false })
    .limit(1)
  return data?.[0] ?? null
}
