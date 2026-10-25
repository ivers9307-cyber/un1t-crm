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
//   whatsapp -> buildWhatsAppAudienceAsync(whatsapp.js; fetchAllWhatsAppAudience pages through it)
//   (none)   -> the contacts with a relationship at the studio — the MATCH set,
//              not a send set (public.studio_contacts at studio_location_id,
//              mig 765: one row per contact here, carrying the stage AT this
//              studio, ORGCONTACTS.4). This is the sequence case: since
//              SEQEXIT.1 a sequence audience is a continuing condition, so
//              there is no "will receive" to compute and no channel gate to
//              apply. It used to be raw contacts at location_id (the primary
//              studio only); decision 3 makes a Stillorgan member who enquired
//              at Hatch a Hatch lead in Hatch's sequences.
//
// Every branch returns the wrapped `{ query }` (never a bare builder): the
// PostgREST builders are thenables, so returning them unwrapped risks the
// HTTP call firing before the caller has chained .order()/.range(). See
// audience-filter.js resolveTagFilters for the full reasoning.

import { buildAudienceQueryAsync } from '@/lib/postmark'
import { buildWhatsAppAudienceAsync } from '@/lib/whatsapp'
import { applyAudienceFilterAsync } from '@/lib/audience-filter'

// 'sms' left with the SMS channel (TWILIO-RETIRE.1) — it is now an unknown channel.
export const ELIGIBILITY_CHANNELS = ['email', 'whatsapp']

/**
 * @param {object} db          service-role Supabase client
 * @param {string|null} channel 'email' | 'whatsapp' | null (match-only)
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
  if (channel === 'whatsapp') {
    return buildWhatsAppAudienceAsync(db, filter, locationId, { columns, selectOpts })
  }
  if (channel) {
    throw new Error(`Unknown audience channel: ${channel}`)
  }
  // Channel-agnostic MATCH set: every contact with a relationship at the
  // studio (studio_contacts, no deliverability gate). The count route's
  // no-channel branch calls this same function, so the sequence preview and
  // the sequence count cannot drift apart. The stage field lands on
  // studio_stage_slug, which the raw contacts table does not have.
  const query = db.from('studio_contacts').select(columns, selectOpts).eq('studio_location_id', locationId)
  return applyAudienceFilterAsync({ db, query, filter, locationId })
}
