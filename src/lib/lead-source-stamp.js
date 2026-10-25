// ORGCONTACTS.4 (spec §2.5) — lead source per studio.
//
// A website form at studio S stamps the contact-wide attribution only when S
// is the contact's PRIMARY studio: first touch (lead_source, stamp-if-null)
// always, as before; last touch (last_lead_source / last_lead_source_at)
// only at the primary. At a sibling studio the record of "what brought them
// to S" is the lead_form contact_studios row the preferences trigger writes
// (mig 764), so a Stillorgan member filling in Hatch's form keeps Stillorgan's
// attribution. Best effort: a failed read never guesses the primary (no last
// touch), and the caller logs a thrown write.
// A supabase builder resolves { error } and never throws, so each write's
// error is read here (BAREWRITE class; M3 of the ORGCONTACTS final review):
// a failed write is named in `failed` and logged, and the other write still
// goes ahead. The caller's result is the truth about what was stamped.
import { logWarn } from '@/lib/log'

export async function stampLeadSource(db, { contactId, locationId, leadSource }) {
  if (!contactId || !leadSource) return { primary: false, lastTouch: false, failed: [] }
  const failed = []
  const { error: firstErr } = await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null)
  if (firstErr) {
    failed.push('first_touch')
    logWarn('lead-source-stamp', 'first touch not stamped', { contactId, locationId, code: firstErr.code ?? null, message: firstErr.message })
  }
  const { data: contact } = await db.from('contacts').select('id, location_id').eq('id', contactId).maybeSingle()
  const primary = !!contact?.location_id && !!locationId && contact.location_id === locationId
  if (!primary) return { primary: false, lastTouch: false, failed }
  const { error: lastErr } = await db.from('contacts')
    .update({ last_lead_source: leadSource, last_lead_source_at: new Date().toISOString() })
    .eq('id', contactId)
  if (lastErr) {
    failed.push('last_touch')
    logWarn('lead-source-stamp', 'last touch not stamped', { contactId, locationId, code: lastErr.code ?? null, message: lastErr.message })
    return { primary: true, lastTouch: false, failed }
  }
  return { primary: true, lastTouch: true, failed }
}
