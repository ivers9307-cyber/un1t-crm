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
// WHICH studios count is the DOOR's question, not this file's (ASSISTREG.3).
// Each door computes the list and puts it on `ctx.readableStudioIds`:
//
//   MCP        mcpReadableStudioIds() below — the person's studios in the
//              resolved studio's organisation, that organisation's MCP switch
//              on, holding `mcp_access` AND Contacts. Otherwise a call
//              resolved at a studio of organisation A would read past
//              organisation B's switch, or past a studio where agent access
//              is off.
//   assistant  the session's active location, if Contacts is held there.
//              It must NOT ask for `mcp_access` or the MCP org switch: those
//              are the MCP door's, and asking for them here is what made
//              create_contact and create_activity unbridgeable — they would
//              have refused every manager (mcp_access is master+owner by
//              default) and everything at CCF Autos, silently. MCPACCESS.1
//              from the other side.
//
// A tool body never recomputes it: it reads what its door decided.

import { hasPermissionForLocation } from '@/lib/permissions'
import { studiosOfContact } from '@/lib/contact-studios'

/**
 * The studios a tool call may read contacts at: whatever its door decided.
 *
 * @param {object} _user kept for signature stability; the answer is the door's
 * @param {{ readableStudioIds?: string[] }} ctx the tool call's context
 */
export function readableContactStudios(_user, ctx) {
  return ctx?.readableStudioIds ?? []
}

/**
 * The MCP door's answer: the person's studios in the resolved studio's
 * organisation, that organisation's MCP switch on, holding BOTH `mcp_access`
 * and `contacts` there.
 *
 * MCPACCESS.1 — two permissions ANDed, and they answer different questions:
 * `mcp_access` is the MCP door (swapped from `assistant`), `contacts` is the
 * data permission. Never collapse them into one.
 *
 * @param {object} user getCurrentUser() result
 * @param {{ studio: { organization_id: string }, enabledOrgIds: string[] }} args
 */
export function mcpReadableStudioIds(user, { studio, enabledOrgIds }) {
  const orgId = studio?.organization_id
  if (!orgId || !(enabledOrgIds || []).includes(orgId)) return []
  return (user?.locations || [])
    .filter((l) => l?.id && l.organization_id === orgId
      && hasPermissionForLocation(user, l.id, 'mcp_access')
      && hasPermissionForLocation(user, l.id, 'contacts'))
    .map((l) => l.id)
}

/**
 * The in-app assistant's answer: the session's active location, if Contacts is
 * held there. No `mcp_access`, no MCP org switch — see the header.
 *
 * @param {object} user getCurrentUser() result
 * @param {string} studioId the session's active location id
 */
export function assistantReadableStudioIds(user, studioId) {
  if (!studioId) return []
  return hasPermissionForLocation(user, studioId, 'contacts') ? [studioId] : []
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
