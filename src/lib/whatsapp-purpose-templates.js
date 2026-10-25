// WAORGNUMBER.2 (R5) — fixed-purpose WhatsApp templates, chosen per studio.
//
// Some senders used to hard-code a template NAME and look it up at the studio
// (booking_class_confirmed_, booking_consult_confirmed, event_waitlist_offer,
// meta_ad_whatsapp_lead). On a WABA shared by several studios only one of them
// can own a template of a given name, so name lookup cannot work for the
// others. Each studio now picks, per purpose, which of ITS OWN templates the
// automatic message uses: locations.settings.whatsapp_purpose_templates
// = { class_confirmed, consult_confirmed, event_waitlist_offer, meta_ad_welcome },
// each value a whatsapp_templates.id at that studio.
//
// resolvePurposeTemplate is the one lookup every such sender goes through.
// With no setting it falls back to today's hard-coded name at the studio, so a
// studio that never picked anything (Stillorgan) behaves exactly as before. A
// studio with neither a pick nor a template of the old name gets null and the
// sender skips quietly (Hatch, until it has its own approved templates).

import { logError, logWarn } from '@/lib/log'

export const PURPOSES = {
  class_confirmed: { fallbackName: 'booking_class_confirmed_', categories: ['UTILITY'] },
  consult_confirmed: { fallbackName: 'booking_consult_confirmed', categories: ['UTILITY'] },
  event_waitlist_offer: { fallbackName: 'event_waitlist_offer', categories: ['UTILITY'] },
  meta_ad_welcome: { fallbackName: 'meta_ad_whatsapp_lead', categories: ['MARKETING', 'UTILITY'] },
}

export const PURPOSE_KEYS = Object.keys(PURPOSES)

// Operator-facing wording for the studio's WhatsApp tab.
export const PURPOSE_LABELS = {
  class_confirmed: { label: 'Class booking confirmed', hint: 'Sent after a class is booked for someone through WhatsApp or the booking page.' },
  consult_confirmed: { label: 'Consultation booking confirmed', hint: 'Sent after a free consultation is booked on the campaign booking page.' },
  event_waitlist_offer: { label: 'Event waitlist offer', hint: 'Sent when a place opens up for someone on an event waitlist.' },
  meta_ad_welcome: { label: 'Welcome for new ad leads', hint: 'Sent the moment someone signs up from a paid campaign page.' },
}

const TEMPLATE_COLUMNS = 'id, location_id, name, language, category, components, status, business_account_id, header_media_url'

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    components: row.components,
    business_account_id: row.business_account_id ?? null,
    header_media_url: row.header_media_url ?? null,
  }
}

/**
 * The APPROVED template this studio uses for a purpose, or null.
 *
 *   1. locations.settings.whatsapp_purpose_templates[purpose], when that
 *      template is at THIS studio and APPROVED;
 *   2. a template id that is at another studio is ignored and logged;
 *   3. else the purpose's fallback name at the studio, APPROVED, newest;
 *   4. else null (the sender skips as it did for a missing template).
 *
 * `fallbackName` overrides the purpose's default name (the ad-lead welcome is
 * configured per campaign in LEAD_CAMPAIGNS).
 *
 * A failed read of the setting or of the chosen template is logged
 * (logError) and the default name is used, as it was before picks existed:
 * losing a confirmation is worse than sending the default one. Only a failed
 * read of the default-named template throws (the sender's try/catch turns it
 * into a quiet `send_failed`, as today).
 *
 * @returns {Promise<{ id, name, language, category, components, business_account_id, header_media_url } | null>}
 */
export async function resolvePurposeTemplate(db, locationId, purpose, { fallbackName } = {}) {
  const def = PURPOSES[purpose]
  if (!def) throw new Error(`Unknown WhatsApp template purpose: ${purpose}`)

  // A failed read of the studio's pick or of the chosen template must not cost
  // the customer their confirmation (the booking is already made and most of
  // these senders are one-shot): log it loudly and carry on with the default
  // name, which is exactly what the sender did before picks existed.
  const { data: location, error: locErr } = await db
    .from('locations').select('id, settings').eq('id', locationId).maybeSingle()
  if (locErr) {
    logError('wa-purpose-templates', 'studio template settings unreadable; using the default template name', { purpose, locationId, err: locErr })
  }

  const chosenId = location?.settings?.whatsapp_purpose_templates?.[purpose]
  if (typeof chosenId === 'string' && chosenId) {
    const { data: chosen, error: chosenErr } = await db
      .from('whatsapp_templates').select(TEMPLATE_COLUMNS).eq('id', chosenId).maybeSingle()
    if (chosenErr) {
      logError('wa-purpose-templates', 'chosen template unreadable; using the default template name', { purpose, locationId, templateId: chosenId, err: chosenErr })
    } else if (chosen && chosen.location_id !== locationId) {
      logWarn('wa-purpose-templates', 'template not at studio', { purpose, locationId, templateId: chosenId, templateLocationId: chosen.location_id })
    } else if (chosen && chosen.status === 'APPROVED') {
      return shape(chosen)
    } else if (chosen) {
      logWarn('wa-purpose-templates', 'chosen template is not approved; using the default template name', { purpose, locationId, templateId: chosenId, status: chosen.status })
    } else {
      logWarn('wa-purpose-templates', 'chosen template no longer exists; using the default template name', { purpose, locationId, templateId: chosenId })
    }
  }

  const { data: rows, error: nameErr } = await db
    .from('whatsapp_templates').select(TEMPLATE_COLUMNS)
    .eq('location_id', locationId)
    .eq('name', fallbackName || def.fallbackName)
    .eq('status', 'APPROVED')
    .order('created_at', { ascending: false })
    .limit(1)
  if (nameErr) throw new Error(`Could not read the studio's templates: ${nameErr.message}`)
  return rows?.[0] ? shape(rows[0]) : null
}
