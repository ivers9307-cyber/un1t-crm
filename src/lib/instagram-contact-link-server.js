// IG-LINK.1 — resolve which CRM contact an Instagram thread belongs to.
//
// IO half of instagram-contact-link.js (the matching rules live there, pure
// and unit-tested). Mirrors the instagram-media-server.js split.
//
// Two ways a thread gets its contact, cheapest first:
//   1. IGSID already stored on a contact (mig 539) — the permanent link. Set
//      once by a human (or by an auto-link/Mia verification) and free forever.
//   2. Exact, unique full-name match on the IG display name — Richard's call.
//      Strictly guarded in pickAutoLinkContact() and logged as an activity so
//      staff can see it was automatic and undo it.
// Anything ambiguous stays unlinked for a human to resolve in the inbox.

import { pickAutoLinkContact } from '@/lib/instagram-contact-link'
import { logWarn } from '@/lib/log'

/** Persist the link on both sides: thread → contact, contact → IGSID/handle. */
export async function linkThreadToContact(db, {
  conversationId, contactId, locationId, igsid, handle,
}) {
  if (!conversationId || !contactId) return false
  const { error: convErr } = await db.from('instagram_conversations')
    .update({ contact_id: contactId, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
  if (convErr) {
    logWarn('ig-contact-link', 'conversation link failed', { conversationId, err: convErr.message })
    return false
  }
  // Backfill the thread's existing messages, or the contact's timeline would
  // start blank at the moment of linking (mirrors the WhatsApp add-contact
  // route). Only fills rows that have no contact yet.
  const { error: msgErr } = await db.from('instagram_messages')
    .update({ contact_id: contactId })
    .eq('conversation_id', conversationId)
    .is('contact_id', null)
  if (msgErr) logWarn('ig-contact-link', 'message backfill failed', { conversationId, err: msgErr.message })
  // Remember the identity so every future thread from this IGSID resolves for
  // free. Best-effort: the thread link above is the part that matters, and the
  // partial unique index is per-location (mig 539) so a clash here is benign.
  if (igsid) {
    const patch = { instagram_igsid: igsid }
    if (handle) patch.instagram_handle = handle
    const { error: cErr } = await db.from('contacts')
      .update(patch)
      .eq('id', contactId)
      .eq('location_id', locationId)
    if (cErr) logWarn('ig-contact-link', 'contact identity stamp failed', { contactId, err: cErr.message })
  }
  return true
}

/**
 * Find (and persist) the contact for an unlinked Instagram thread.
 * Returns the contact id, or null when nothing resolves safely.
 * Never throws — inbound message handling must not depend on this.
 */
export async function resolveContactForInstagramThread(db, {
  conversationId, locationId, igsid, displayName, handle,
}) {
  if (!db || !conversationId || !locationId || !igsid) return null
  try {
    // 1. Known identity → permanent link, no guessing.
    const { data: known } = await db.from('contacts')
      .select('id')
      .eq('location_id', locationId)
      .eq('instagram_igsid', igsid)
      .limit(1)
      .maybeSingle()
    if (known?.id) {
      await linkThreadToContact(db, { conversationId, contactId: known.id, locationId, igsid, handle })
      return known.id
    }

    // 2. Exact unique full-name auto-link. Candidates are narrowed in SQL
    //    (case-insensitive equality, capped) so this never walks the contact
    //    book; pickAutoLinkContact then enforces "exactly one" plus the
    //    don't-steal-a-bound-identity rule. Accented/punctuated spellings that
    //    SQL misses simply fall through to manual linking — fails closed.
    const name = (displayName || '').trim()
    if (!name) return null
    const { data: candidates } = await db.from('contacts')
      .select('id, name, first_name, last_name, instagram_igsid')
      .eq('location_id', locationId)
      .ilike('name', name)
      .limit(20)

    const match = pickAutoLinkContact(candidates || [], name, igsid)
    if (!match) return null

    const ok = await linkThreadToContact(db, {
      conversationId, contactId: match.id, locationId, igsid, handle,
    })
    if (!ok) return null

    // Visible + undoable: staff should never wonder why a thread attached
    // itself to a member.
    try {
      await db.from('activities').insert({
        contact_id: match.id,
        location_id: locationId,
        kind: 'event',
        type: 'instagram',
        subject: `Instagram ${handle ? `@${handle}` : 'account'} linked automatically`,
        note: `Matched the Instagram display name "${name}" to this contact. Unlink from the Instagram thread if this is the wrong person.`,
        done: true,
      })
    } catch { /* activity is a nicety, never block the link */ }

    return match.id
  } catch (e) {
    logWarn('ig-contact-link', 'resolve failed', { conversationId, err: e?.message })
    return null
  }
}
