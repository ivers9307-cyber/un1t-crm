// WAHOMESTUDIO.1 (R1) — where a WhatsApp thread for a contact belongs when it
// is opened on another studio's number (an outbound send, a coexistence echo).
//
// A contact whose home studio has no WhatsApp number of its own, in the SAME
// organisation as the number's studio, gets the thread at their home studio:
// Hatch Street's customers sit in the Hatch inbox, and replies go through the
// organisation number stamped on the thread (getConversationNumberConfig, R4).
// Anything else — a home studio with its own number, another organisation, no
// contact, a failed read — returns null and the caller files where it always
// has. Spec: docs/superpowers/specs/2026-10-15-wa-home-studio-threads-design.md
import { logWarn } from './log'

export async function numberlessHomeStudio(db, contact, numberLocationId) {
  if (!contact || !numberLocationId) return null
  try {
    let home = contact.location_id
    if (home === undefined && contact.id) {
      const { data, error } = await db.from('contacts').select('location_id').eq('id', contact.id).maybeSingle()
      if (error) throw error
      home = data?.location_id
    }
    if (!home || home === numberLocationId) return null

    const { data: own, error: ownErr } = await db.from('whatsapp_numbers')
      .select('id').eq('location_id', home).eq('is_active', true).limit(1)
    if (ownErr) throw ownErr
    if (own && own.length > 0) return null

    const { data: locs, error: locErr } = await db.from('locations')
      .select('id, organization_id').in('id', [home, numberLocationId])
    if (locErr) throw locErr
    const orgOf = (id) => (locs || []).find((l) => l.id === id)?.organization_id || null
    const homeOrg = orgOf(home)
    return homeOrg && homeOrg === orgOf(numberLocationId) ? home : null
  } catch (e) {
    logWarn('wa-thread-location', 'home studio lookup failed; filing at the number’s studio', {
      contactId: contact.id || null, numberLocationId, err: e?.message || String(e),
    })
    return null
  }
}
