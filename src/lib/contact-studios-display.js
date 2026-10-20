// ORGCONTACTS.2 — the contact page's Studios card: every studio the person
// has a relationship with (contact_studios, mig 764), any status, the
// primary studio first, each with its location row. Never throws. Lived in
// contact-memberships.js until ORGCONTACTS.5 retired the memberships card.
import { studiosOfContact } from './contact-studios.js'

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
