// FILTER-B.4 — ONE definition of "who would actually receive this", per channel.
//
// The audience preview exists so an operator can check a filter WITHOUT
// sending to it. That is only worth anything if the preview lists exactly the
// people the send would reach: a preview that disagrees with the send is worse
// than no preview, because it manufactures false confidence at precisely the
// moment someone is checking their work.
//
// So the preview does not get its own query. It calls the same per-channel
// SEND-PATH builder the send uses, and so does the count route's
// will-receive number — three surfaces, one query path, by construction
// rather than by convention:
//
//   email    -> buildAudienceQueryAsync   (postmark.js; campaign-sender.js sends through it)
//   sms      -> buildSmsAudienceAsync     (sms.js; fetchAllSmsAudience pages through it)
//   whatsapp -> buildWhatsAppAudienceAsync(whatsapp.js; fetchAllWhatsAppAudience pages through it)
//   (none)   -> raw contacts at the location — the MATCH set, not a send set.
//              This is the sequence case: since SEQEXIT.1 a sequence audience
//              is a continuing condition, so there is no "will receive" to
//              compute and no channel gate to apply.
//
// Every branch returns the wrapped `{ query }` (never a bare builder): the
// PostgREST builders are thenables, so returning them unwrapped risks the
// HTTP call firing before the caller has chained .order()/.range(). See
// audience-filter.js resolveTagFilters for the full reasoning.

import { buildAudienceQueryAsync } from '@/lib/postmark'
import { buildSmsAudienceAsync } from '@/lib/sms'
import { buildWhatsAppAudienceAsync } from '@/lib/whatsapp'
import { applyAudienceFilterAsync } from '@/lib/audience-filter'

export const ELIGIBILITY_CHANNELS = ['email', 'sms', 'whatsapp']

/**
 * @param {object} db          service-role Supabase client
 * @param {string|null} channel 'email' | 'sms' | 'whatsapp' | null (match-only)
 * @param {object} filter      audience filter JSON
 * @param {string} locationId  tenant scope — ALWAYS applied by the delegate
 * @param {string} [columns]   columns to select
 * @param {object} [selectOpts] { count, head } — must ride the FIRST select()
 * @param {string} [consentField] email only: email_marketing | email_administrative
 * @returns {Promise<{query: object}>}
 */
export async function buildEligibleAudienceQuery({
  db, channel, filter, locationId, columns = 'id', selectOpts, consentField = 'email_marketing',
}) {
  if (channel === 'email') {
    return buildAudienceQueryAsync(db, filter, locationId, { columns, selectOpts, consentField })
  }
  if (channel === 'sms') {
    return buildSmsAudienceAsync(db, filter, locationId, { columns, selectOpts })
  }
  if (channel === 'whatsapp') {
    return buildWhatsAppAudienceAsync(db, filter, locationId, { columns, selectOpts })
  }
  if (channel) {
    throw new Error(`Unknown audience channel: ${channel}`)
  }
  // Channel-agnostic MATCH set. Mirrors the count route's no-channel branch
  // exactly (raw contacts at the location, no deliverability gate) so the
  // sequence preview and the sequence count cannot drift apart.
  const query = db.from('contacts').select(columns, selectOpts).eq('location_id', locationId)
  return applyAudienceFilterAsync({ db, query, filter, locationId })
}
