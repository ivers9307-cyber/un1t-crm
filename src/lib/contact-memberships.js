// HATCH-MEMBERS.1 (mig 722) — memberships held outside Glofox, for display.
//
// contact_memberships is written by the operator-run import of a studio's
// own client export (today: Hatch Street's un1t.online export). Event member
// pricing reads it in member-validation.js; this module only serves the
// contact page.

import { studiosOfContact } from './contact-studios.js'

export const MEMBERSHIP_SOURCE_LABELS = Object.freeze({
  un1t_online_export: 'un1t.online (import)',
  un1t_online_api: 'un1t.online',
})

/**
 * Every membership row for one contact, active first, with its studio name.
 * The caller has already authorised the contact (canViewContact). A failed
 * read returns [] with the error, never throws: a profile must not blank.
 *
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function loadContactMemberships(db, contactId) {
  if (!db || !contactId) return { rows: [], error: null }
  const { data, error } = await db
    .from('contact_memberships')
    .select('id, plan_name, status, source, last_seen_at, ended_at, location_id, locations:location_id ( name )')
    .eq('contact_id', contactId)
    .order('status', { ascending: true })
    .order('last_seen_at', { ascending: false })
    .limit(20)
  if (error) return { rows: [], error }
  return { rows: Array.isArray(data) ? data : [], error: null }
}

// ORGCONTACTS.2 — the contact page's Studios card: every studio the person
// has a relationship with (contact_studios, mig 764), any status, the
// primary studio first, each with its location row. Never throws.
export const RELATIONSHIP_SOURCE_LABELS = Object.freeze({
  glofox: 'Glofox',
  un1t_online: 'un1t.online',
  lead_form: 'Lead form',
  deal: 'Pipeline',
  manual: 'Added by staff',
  import: 'Import',
})

/**
 * @returns {Promise<{ rows: Array<object>, error: string|null }>}
 */
export async function loadContactStudios(db, contactId, { primaryLocationId = null } = {}) {
  if (!db || !contactId) return { rows: [], error: null }
  const r = await studiosOfContact(db, contactId)
  if (!r.ok) return { rows: [], error: r.error }
  const rows = [...r.rows].sort((a, b) =>
    Number(b.location_id === primaryLocationId) - Number(a.location_id === primaryLocationId)
    || String(a.location?.name || '').localeCompare(String(b.location?.name || '')))
  return { rows, error: null }
}
