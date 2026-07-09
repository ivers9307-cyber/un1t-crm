// GLOFOX-NOTES — outbound push service. Fire-and-forget: a CRM note / logged
// call-email touchpoint is copied into Glofox as an interaction ONCE on create.
// Never throws to the caller (best-effort side effect). Records every push in
// glofox_note_pushes so the inbound sync can claim the echo and suppress the
// duplicate (Task 5).

import { glofoxCredentialsForLocation, createGlofoxInteraction } from './glofox.js'
import { buildInteractionDescription } from './glofox-notes.js'
import { logWarn } from './log.js'

/**
 * @param db  service-role client
 * @param {object} args
 *   contactId, sourceTable ('notes'|'activities'), sourceId,
 *   type ('NOTE'|'MANUAL_EMAIL'), authorName?, content
 * @returns {Promise<{pushed:boolean, reason?:string}>}
 */
export async function pushNoteToGlofox(db, { contactId, sourceTable, sourceId, type, authorName, content }) {
  try {
    if (!contactId || !sourceId || !content) return { pushed: false, reason: 'missing args' }

    const { data: contact } = await db
      .from('contacts')
      .select('id, location_id, glofox_member_id')
      .eq('id', contactId)
      .single()
    if (!contact || !contact.glofox_member_id) return { pushed: false, reason: 'no glofox member' }

    // glofoxCredentialsForLocation returns an object with null fields (never
    // falsy) when a location has no Glofox config — so guard on branchId, or
    // non-Glofox locations (CCF Autos, SourceIt) would log bogus 'failed'
    // pushes and hit the API pointlessly.
    const creds = await glofoxCredentialsForLocation(db, contact.location_id)
    if (!creds || !creds.branchId) return { pushed: false, reason: 'no glofox creds' }

    const { description, truncated } = buildInteractionDescription({ authorName, content })
    const res = await createGlofoxInteraction(creds, contact.glofox_member_id, { type, description })

    await db.from('glofox_note_pushes').insert({
      contact_id: contactId,
      location_id: contact.location_id,
      glofox_member_id: contact.glofox_member_id,
      source_table: sourceTable,
      source_id: sourceId,
      type,
      description,
      truncated,
      status: res.ok ? 'sent' : 'failed',
    })
    return { pushed: res.ok }
  } catch (e) {
    logWarn('glofox-note-push', 'push threw', { err: e?.message, contactId })
    return { pushed: false, reason: 'threw' }
  }
}
