// MCP.1 — which contacts a person may read through the agent tools. Not a
// tool (tests/agent-tools-guard.test.js NOT_TOOLS).
//
// The rule is the contacts_select policy's (mig 690, ORGCONTACTS.2), applied
// in app code because the tools run on the service role: a contact is
// readable at a studio where the person holds the web Contacts permission
// when it is homed there (`contacts.location_id`) OR has a `contact_studios`
// row there, any status (a Glofox sibling-studio contact is attached that
// way, never moved). An unknown contact and an unreadable one get the same
// answer (null → the tool's `not_found`), so a contact id cannot be probed.

import { hasPermissionForLocation } from '@/lib/permissions'
import { studiosOfContact } from '@/lib/contact-studios'

/** The ids of the person's studios where they hold Contacts. */
export function readableContactStudios(user) {
  return (user?.locations || [])
    .filter((l) => l?.id && hasPermissionForLocation(user, l.id, 'contacts'))
    .map((l) => l.id)
}

/**
 * The first readable studio for this contact: its home studio when readable,
 * else the first readable studio where it has a relationship row. A failed
 * read throws (a failed call, never "not found").
 *
 * @returns {Promise<string | null>}
 */
export async function contactReadableAt(db, user, contactId) {
  const readable = readableContactStudios(user)
  if (!contactId || readable.length === 0) return null

  const { data: contact, error } = await db.from('contacts')
    .select('id, location_id')
    .in('id', [contactId])
    .maybeSingle()
  if (error) throw new Error(`Failed to load the contact: ${error.message}`)
  if (!contact) return null
  if (readable.includes(contact.location_id)) return contact.location_id

  const studios = await studiosOfContact(db, contactId)
  if (!studios.ok) throw new Error(`Failed to load the contact's studios: ${studios.error}`)
  const at = new Set(studios.rows.map((r) => r.location_id))
  return readable.find((id) => at.has(id)) ?? null
}
