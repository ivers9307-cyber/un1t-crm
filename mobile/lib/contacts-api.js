// W1 — mobile contacts (read vertical). A searchable member directory +
// contact detail for looking someone up and calling/messaging them.
// Direct Supabase: the `contacts` table is granted to the authenticated
// role and RLS-scoped by location (contacts_location_scoped, mig 014),
// the same trust model pipeline-api.js uses. Editing stays on web.
import { supabase } from './supabase'

// The activity + note readers already exist for the pipeline deal card —
// reuse them on the contact detail so we don't duplicate the queries.
export { listActivitiesForContact, listNotesForContact } from './pipeline-api'

const CONTACT_SELECT =
  'id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug, lead_source, tags, created_at'

/**
 * Search contacts at a location by name / phone / email. Empty query
 * returns the most-recent contacts (a cheap default before the operator
 * types). Capped at `limit` — this is a lookup tool, not a bulk export.
 */
export async function searchContacts({ locationId, query = '', limit = 40 }) {
  if (!locationId) return { success: false, error: 'locationId required' }
  let q = supabase.from('contacts').select(CONTACT_SELECT).eq('location_id', locationId)
  const term = (query || '').trim()
  if (term) {
    // Commas + % are PostgREST .or()/ilike control chars — strip them so
    // a search term can't break the filter or smuggle a wildcard.
    const safe = term.replace(/[,%]/g, ' ').trim()
    q = q.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,wa_phone.ilike.%${safe}%,email.ilike.%${safe}%`)
    q = q.order('name', { ascending: true })
  } else {
    q = q.order('created_at', { ascending: false })
  }
  const { data, error } = await q.limit(limit)
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/** One contact by id (location scope enforced by RLS). */
export async function getContact(id) {
  if (!id) return { success: false, error: 'id required' }
  const { data, error } = await supabase.from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: 'Contact not found' }
  return { success: true, data }
}

/** new_lead → "New lead" for display. */
export function prettyStage(slug) {
  if (!slug) return null
  return slug.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

export function contactDisplayName(c) {
  if (!c) return 'Contact'
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Contact'
}
