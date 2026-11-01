// MCP.1 — `search_contacts`: contacts at the studio whose name, email or phone
// contains the term. "At the studio" is the Contacts list's rule (ORGCONTACTS.2):
// homed there, or holding a contact_studios row there (any status). Two reads,
// merged by id: the homed contacts (`.eq('location_id', studio)`) and the
// relationship rows at the studio with their contact embedded and filtered on
// the term (`contacts!inner`, so a row whose contact does not match drops out).
// One `.or` across both is not expressible, and an id list of every
// relationship at a studio (thousands at Stillorgan) cannot travel as a URL.

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { hasPermissionForLocation } from '@/lib/permissions'
import { sanitizeSearchTerm, MIN_CONTACT_SEARCH_LEN } from '@/lib/command-palette'

const MAX_ROWS = 20
const CONTACT_COLUMNS = 'id, name, email, phone, location_id, pipeline_stage_slug, lead_source'

export default defineTool({
  name: 'search_contacts',
  title: 'Search contacts',
  description: 'Find contacts at a studio by part of their name, email or phone (at least 2 characters). '
    + 'Includes contacts homed at another studio of the organisation who have a relationship with this one. '
    + 'Returns at most 20 (capped is true when there are more: narrow the term). Needs the Contacts permission.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    query: z.string().max(200).describe('Part of a name, email address or phone number.'),
  }),
  gate: (user, studioId) => hasPermissionForLocation(user, studioId, 'contacts'),
  run: async (input, ctx) => {
    const { db, studio } = ctx
    // sanitizeSearchTerm() leaves " and \, which PostgREST rejects inside an
    // .or() value (a 400 on every call), so they go too.
    const term = sanitizeSearchTerm(input.query).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
    if (term.length < MIN_CONTACT_SEARCH_LEN) {
      throw new ToolRefusal('invalid_input', `The search term needs at least ${MIN_CONTACT_SEARCH_LEN} characters (commas, brackets, quotes, backslashes, % * and _ are ignored).`)
    }
    // Deliberate substring search: sanitizeSearchTerm() and the line above stripped , ( ) % * _ " \,
    // so the term carries neither LIKE wildcards nor .or() separators.
    const like = `%${term}%`
    const matches = `name.ilike.${like},email.ilike.${like},phone.ilike.${like}`

    const [homed, related] = await Promise.all([
      db.from('contacts')
        .select(CONTACT_COLUMNS)
        .eq('location_id', studio.id)
        .or(matches)
        .order('name', { ascending: true })
        .limit(MAX_ROWS + 1),
      db.from('contact_studios')
        .select(`contact_id, contacts!inner(${CONTACT_COLUMNS})`)
        .eq('location_id', studio.id)
        .or(matches, { referencedTable: 'contacts' })
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(MAX_ROWS + 1),
    ])
    if (homed.error) throw new Error(`Failed to search contacts: ${homed.error.message}`)
    if (related.error) throw new Error(`Failed to search contacts: ${related.error.message}`)

    const byId = new Map()
    for (const c of homed.data || []) byId.set(c.id, c)
    for (const r of related.data || []) if (r.contacts && !byId.has(r.contacts.id)) byId.set(r.contacts.id, r.contacts)
    const contacts = [...byId.values()]

    return {
      studio: { id: studio.id, name: studio.name },
      contacts: contacts.slice(0, MAX_ROWS),
      capped: contacts.length > MAX_ROWS || (homed.data || []).length > MAX_ROWS || (related.data || []).length > MAX_ROWS,
    }
  },
})
