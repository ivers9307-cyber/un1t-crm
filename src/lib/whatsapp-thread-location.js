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

// WAHOMESTUDIO.1 (Task 4b) — the studios in `locationId`'s organisation (never
// `locationId` itself) that have NO active whatsapp_numbers row. A template
// sent from `locationId` into a thread filed at one of them carries that
// sibling's location_id (the message follows its thread, mig 723), so the send
// budget counts their outbound template rows against `locationId`.
// Unlike numberlessHomeStudio this THROWS on a failed read: the budget fails
// closed ("WhatsApp budget usage query failed"), and a smaller sibling set would
// free up phantom headroom. An unknown studio or one with no organisation has no
// siblings: [].
export async function numberlessSiblingLocationIds(db, locationId) {
  if (!locationId) return []
  const { data: self, error: selfErr } = await db.from('locations')
    .select('organization_id').eq('id', locationId).maybeSingle()
  if (selfErr) throw new Error(`WhatsApp sibling studio lookup failed: ${selfErr.message}`)
  const orgId = self?.organization_id
  if (!orgId) return []

  const { data: siblings, error: sibErr } = await db.from('locations')
    .select('id').eq('organization_id', orgId).neq('id', locationId)
  if (sibErr) throw new Error(`WhatsApp sibling studio lookup failed: ${sibErr.message}`)
  const ids = (siblings || []).map((l) => l.id)
  if (ids.length === 0) return []

  const { data: numbered, error: numErr } = await db.from('whatsapp_numbers')
    .select('location_id').in('location_id', ids).eq('is_active', true)
  if (numErr) throw new Error(`WhatsApp sibling studio lookup failed: ${numErr.message}`)
  const withNumber = new Set((numbered || []).map((n) => n.location_id))
  return ids.filter((id) => !withNumber.has(id))
}
