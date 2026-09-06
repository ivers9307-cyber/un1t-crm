// HOST-CONSENT.1 — the ONE writer of host marketing consent.
//
// Host marketing is its own consent domain (spec:
// docs/superpowers/specs/2026-09-06-host-consent-domain-design.md).
//   grant   → host_contacts.marketing_consent = true (+ when/source), one
//             consent_log row, channel 'host_email_marketing', host_id set.
//   revoke  → host_email_suppressions row (insert-once) AND
//             marketing_consent=false, one opt_out row.
//   resub   → delete the suppression row, then grant (source host_resubscribe).
// None of these touch contacts.email_marketing / contact_preferences —
// that is the UN1T domain and the whole point is that the two never cross.
//
// Postmark suppress/unsuppress on the host's stream is the CALLER's
// fire-and-forget side effect (it needs the host row's postmark_stream_id),
// kept out of here so this module stays a pure-DB unit.
//
// Every write destructures `error` (CLAUDE.md: a bare supabase write resolves
// rather than throws) and returns {ok, changed} so a caller can judge it.

import { logError } from './log.js'
import { CONSENT_ACTIONS } from './consent-actions.js'

export const HOST_CONSENT_CHANNEL = 'host_email_marketing'

function logRow({ contactId, hostId, action, source, ipAddress }) {
  return {
    contact_id: contactId,
    channel: HOST_CONSENT_CHANNEL,
    action,
    source,
    ip_address: ipAddress ?? null,
    host_id: hostId,
    location_id: null,
  }
}

async function insertLog(db, rows) {
  if (!rows.length) return
  const { error } = await db.from('consent_log').insert(rows)
  // The consent decision is already durable in host_contacts /
  // host_email_suppressions; a lost audit row is logged, never thrown.
  if (error) logError('host-consent', 'consent_log insert failed', { error: error.message, rows: rows.length, hostId: rows[0]?.host_id, contactIds: rows.map((r) => r.contact_id) })
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role
 * @param {{hostId:string, contactId:string, source:'mailing_list_form'|'event_form'|'host_resubscribe', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string, code?: string|null}>} code is the Postgres SQLSTATE when the driver supplied one; 23503 = FK violation = the contact no longer exists.
 */
export async function grantHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
  // Requires an existing host_contacts row; changed:false also means "no membership".
  const { data, error } = await db
    .from('host_contacts')
    .update({
      marketing_consent: true,
      marketing_consented_at: new Date().toISOString(),
      marketing_consent_source: source,
    })
    .eq('host_id', hostId)
    .eq('contact_id', contactId)
    .eq('marketing_consent', false)
    .select('contact_id')
  if (error) return { ok: false, changed: false, error: error.message, code: error.code ?? null }
  const changed = (data || []).length > 0
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: CONSENT_ACTIONS.OPT_IN, source, ipAddress })])
  return { ok: true, changed }
}

/**
 * Attendee-sync variant: one UPDATE for many contacts, one log row per
 * contact that actually flipped. Caller chunks to ≤500 ids.
 * @param {{hostId:string, contactIds:string[], source:'event_form'|'mailing_list_form'|'host_resubscribe'}} args
 * @returns {Promise<{ok:boolean, changed:number, error?:string}>}
 */
export async function grantHostConsentBulk(db, { hostId, contactIds, source }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (ids.length === 0) return { ok: true, changed: 0 }
  const { data, error } = await db
    .from('host_contacts')
    .update({
      marketing_consent: true,
      marketing_consented_at: new Date().toISOString(),
      marketing_consent_source: source,
    })
    .eq('host_id', hostId)
    .in('contact_id', ids)
    .eq('marketing_consent', false)
    .select('contact_id')
  if (error) return { ok: false, changed: 0, error: error.message, code: error.code ?? null }
  const flipped = (data || []).map((r) => r.contact_id)
  await insertLog(db, flipped.map((contactId) => logRow({ contactId, hostId, action: CONSENT_ACTIONS.OPT_IN, source, ipAddress: null })))
  return { ok: true, changed: flipped.length }
}

/**
 * @param {{hostId:string, contactId:string, source:'host_unsubscribe_page'|'host_one_click_unsubscribe'|'postmark_one_click_unsubscribe'|'postmark_spam_complaint', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string, code?: string|null}>} code is the Postgres SQLSTATE when the driver supplied one; 23503 = FK violation = the contact no longer exists.
 */
export async function revokeHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
  const { data: supRows, error: supError } = await db
    .from('host_email_suppressions')
    .upsert({ host_id: hostId, contact_id: contactId }, { onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    .select('id')
  if (supError) return { ok: false, changed: false, error: supError.message, code: supError.code ?? null }
  // ignoreDuplicates returns zero rows when the pair already existed.
  const suppressed = (supRows || []).length > 0

  // Keep consent in step with the suppression so a later resubscribe flips a
  // real value (grantHostConsent is scoped to marketing_consent = false) and
  // the audit trail pairs every opt_out with the opt_in that ends it.
  const { data: consentRows, error: consentError } = await db
    .from('host_contacts')
    .update({ marketing_consent: false })
    .eq('host_id', hostId)
    .eq('contact_id', contactId)
    .eq('marketing_consent', true)
    .select('contact_id')
  if (consentError) return { ok: false, changed: suppressed, error: consentError.message, code: consentError.code ?? null }
  const unconsented = (consentRows || []).length > 0

  const changed = suppressed || unconsented
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: CONSENT_ACTIONS.OPT_OUT, source, ipAddress })])
  return { ok: true, changed }
}

/**
 * Re-signup by a previously unsubscribed contact.
 * @returns {Promise<{ok:boolean, unsuppressed:boolean, changed:boolean, error?:string}>}
 */
export async function resubscribeHost(db, { hostId, contactId, ipAddress = null }) {
  const { data, error } = await db
    .from('host_email_suppressions')
    .delete()
    .eq('host_id', hostId)
    .eq('contact_id', contactId)
    .select('id')
  if (error) return { ok: false, unsuppressed: false, changed: false, error: error.message, code: error.code ?? null }
  const unsuppressed = (data || []).length > 0
  // Not atomic. A failed grant leaves the row unsuppressed with consent=false, which is NOT mailable (deliverability needs both), and a retry is idempotent.
  const grant = await grantHostConsent(db, { hostId, contactId, source: 'host_resubscribe', ipAddress })
  if (!grant.ok) return { ok: false, unsuppressed, changed: false, error: grant.error }
  return { ok: true, unsuppressed, changed: grant.changed }
}
