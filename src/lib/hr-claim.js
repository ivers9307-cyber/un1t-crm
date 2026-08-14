// src/lib/hr-claim.js
//
// HR-CLAIM.1 — one-tap "Claim for member" on the coach Detected tab. Pure
// decision logic only (the route/UI stay thin):
//   rankClaimCandidates      — member-picker ordering: who's booked into the
//                              live class first, then the name-search fallback
//   findRegistrationConflict — never silently steal a strap that's actively
//                              registered to a different member
//   planAnonAdoption         — may TODAY's open contact-less session be
//                              adopted onto the claiming member? (mig 343:
//                              one open session per member per location)

/**
 * Pure: rank member-picker candidates for claiming a strap. Members on the
 * live class roster (class_bookings rows, getClassRoster shape) come first,
 * tagged `on_roster: true`; the location-wide name-search results fill in
 * behind, deduped by contact id. Roster rows with no CRM contact_id are
 * skipped (nothing to register against), as are cancelled bookings. `query`
 * filters roster rows by name the same way the search already filtered the
 * contacts server-side (case-insensitive substring).
 *
 * @param {{ roster?: Array<{contact_id:string|null, member_name:string|null, status:string|null}>,
 *   contacts?: Array<{id:string, name:string|null}>, query?: string }} opts
 * @returns {Array<{id:string, name:string, on_roster:boolean}>}
 */
export function rankClaimCandidates({ roster = [], contacts = [], query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const out = []
  const seen = new Set()
  for (const r of roster || []) {
    if (!r?.contact_id) continue
    if (String(r.status || '').toUpperCase() === 'CANCELLED') continue
    if (seen.has(r.contact_id)) continue
    const name = r.member_name || null
    if (q && !String(name || '').toLowerCase().includes(q)) continue
    seen.add(r.contact_id)
    out.push({ id: r.contact_id, name: name || '—', on_roster: true })
  }
  for (const c of contacts || []) {
    if (!c?.id || seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ id: c.id, name: c.name || '—', on_roster: false })
  }
  return out
}

/**
 * Pure: given the ACTIVE contact_devices rows for a device identifier, find a
 * registration held by a different contact. Any location counts — the strap
 * is one member's hardware, so a cross-location holder still blocks the claim
 * — but the holder's name is only surfaced when they belong to the claiming
 * location (never leak a cross-tenant name).
 *
 * @param {{ deviceRows?: Array<{contact_id:string, is_active?:boolean,
 *   contacts?: {name:string|null, location_id:string|null}|null }>,
 *   contactId: string, locationId: string }} opts
 * @returns {{ contactId: string, name: string|null } | null}
 */
export function findRegistrationConflict({ deviceRows = [], contactId, locationId } = {}) {
  for (const row of deviceRows || []) {
    if (!row || row.is_active === false) continue
    if (!row.contact_id || row.contact_id === contactId) continue
    const sameLocation = row.contacts?.location_id === locationId
    return { contactId: row.contact_id, name: sameLocation ? (row.contacts?.name || null) : null }
  }
  return null
}

/**
 * Pure: decide whether the strap's current contact-less session may be
 * adopted onto the claiming member (so they get TODAY's class, not just
 * future ones). Adoption is refused when:
 *   - there is no open anonymous session for the strap, or
 *   - the member already has an OPEN session at the location — stamping
 *     contact_id would trip the mig 343 one-open-per-member index.
 * The candidate must be genuinely anonymous (contact_id null) and open
 * (ended_at null) — defence in depth on top of the caller's query filters;
 * an ended session is history and is NEVER adopted.
 *
 * @param {{ anonSession?: {id:string, contact_id?:string|null, ended_at?:string|null}|null,
 *   memberOpenSessionId?: string|null }} opts
 * @returns {{ adoptId: string|null, reason: string|null }}
 */
export function planAnonAdoption({ anonSession = null, memberOpenSessionId = null } = {}) {
  if (memberOpenSessionId) return { adoptId: null, reason: 'member-has-open-session' }
  if (!anonSession?.id) return { adoptId: null, reason: 'no-open-anon-session' }
  if (anonSession.contact_id != null) return { adoptId: null, reason: 'not-anonymous' }
  if (anonSession.ended_at != null) return { adoptId: null, reason: 'already-ended' }
  return { adoptId: anonSession.id, reason: null }
}
