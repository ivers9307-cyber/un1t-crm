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
//
// Through MCP the studios that count are narrower than the person's Contacts
// studios: only those in the resolved studio's organisation, whose
// organisation has MCP switched on, where the person holds the AI Assistant
// permission as well as Contacts. Otherwise a call resolved at a studio of
// organisation A would read past organisation B's switch, or past a studio
// where the assistant is off.

import { hasPermissionForLocation } from '@/lib/permissions'
import { studiosOfContact } from '@/lib/contact-studios'

/**
 * The ids of the person's studios a tool call may read contacts at: in the
 * resolved studio's organisation, that organisation's MCP switch on, and the
 * person holding `assistant` AND `contacts` there.
 *
 * @param {object} user getCurrentUser() result
 * @param {{ studio: { organization_id: string }, enabledOrgIds: string[] }} ctx the tool call's context
 */
export function readableContactStudios(user, ctx) {
  const orgId = ctx?.studio?.organization_id
  if (!orgId || !(ctx.enabledOrgIds || []).includes(orgId)) return []
  return (user?.locations || [])
    .filter((l) => l?.id && l.organization_id === orgId
      && hasPermissionForLocation(user, l.id, 'assistant')
      && hasPermissionForLocation(user, l.id, 'contacts'))
    .map((l) => l.id)
}

/**
 * The first readable studio for this contact: its home studio when readable,
 * else the first readable studio where it has a relationship row. A failed
 * read throws (a failed call, never "not found").
 *
 * @returns {Promise<string | null>}
 */
export async function contactReadableAt(db, user, contactId, ctx) {
  const readable = readableContactStudios(user, ctx)
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
