// HOST-CONSENT.1 — the ONE writer of host marketing consent.
//
// Host marketing is its own consent domain (spec:
// docs/superpowers/specs/2026-09-06-host-consent-domain-design.md).
//   grant   → host_contacts.marketing_consent = true (+ when/source), one
//             consent_log row, channel 'host_email_marketing', host_id set.
//   revoke  → host_email_suppressions row (insert-once), one opt_out row.
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
  if (error) logError('host-consent', 'consent_log insert failed', { error: error.message, rows: rows.length })
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role
 * @param {{hostId:string, contactId:string, source:'mailing_list_form'|'event_form'|'host_resubscribe', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string}>}
 */
export async function grantHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
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
  if (error) return { ok: false, changed: false, error: error.message }
  const changed = (data || []).length > 0
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: 'opt_in', source, ipAddress })])
  return { ok: true, changed }
}

/**
 * Attendee-sync variant: one UPDATE for many contacts, one log row per
 * contact that actually flipped. Caller chunks to ≤500 ids.
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
  if (error) return { ok: false, changed: 0, error: error.message }
  const flipped = (data || []).map((r) => r.contact_id)
  await insertLog(db, flipped.map((contactId) => logRow({ contactId, hostId, action: 'opt_in', source, ipAddress: null })))
  return { ok: true, changed: flipped.length }
}

/**
 * @param {{hostId:string, contactId:string, source:'host_unsubscribe_page'|'host_one_click_unsubscribe'|'postmark_one_click_unsubscribe'|'postmark_spam_complaint', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string}>}
 */
export async function revokeHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
  const { data, error } = await db
    .from('host_email_suppressions')
    .upsert({ host_id: hostId, contact_id: contactId }, { onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    .select('id')
  if (error) return { ok: false, changed: false, error: error.message }
  // ignoreDuplicates returns zero rows when the pair already existed.
  const changed = (data || []).length > 0
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: 'opt_out', source, ipAddress })])
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
  if (error) return { ok: false, unsuppressed: false, changed: false, error: error.message }
  const unsuppressed = (data || []).length > 0
  const grant = await grantHostConsent(db, { hostId, contactId, source: 'host_resubscribe', ipAddress })
  if (!grant.ok) return { ok: false, unsuppressed, changed: false, error: grant.error }
  return { ok: true, unsuppressed, changed: grant.changed }
}
