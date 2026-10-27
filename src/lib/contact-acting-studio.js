// CARDLENS.4 — the ACTING studio on the contact page: the studio a viewer
// messages, notes, books and judges permissions at. Before this, every action
// was judged at contacts.location_id (the primary studio), so a Hatch Street
// coach could not work a Stillorgan-primary person who trains at Hatch.
//
// A studio is an option when the viewer belongs to it (masters belong
// everywhere) AND the person has a contact_studios row there, ANY status
// (Richard 2026-10-27: the same rule as visibility, ORGCONTACTS decision 2).
// The primary studio always counts, so a failed contact_studios read leaves the
// page exactly as it was before. Closed studios and host anchors never act.
import { NextResponse } from 'next/server'
import { isMemberOfContactStudio } from './contact-page-gates'
import { hasRelationshipAt } from './contact-studios'

/**
 * @param {{ user: object, contact: object, studioRows: Array<object> }} a
 *   studioRows: loadContactStudios(...).rows (each with `location`)
 * @returns {Array<{ locationId: string, name: string, source: string|null, primary: boolean }>}
 *   primary first, then by name
 */
export function actingStudioOptions({ user, contact, studioRows }) {
  const primaryId = contact?.location_id || null
  const out = new Map()
  for (const r of studioRows || []) {
    const loc = r?.location
    if (!r?.location_id || out.has(r.location_id)) continue
    if (loc?.active === false || loc?.is_host_anchor === true) continue
    if (!isMemberOfContactStudio(user, r.location_id)) continue
    out.set(r.location_id, {
      locationId: r.location_id,
      name: loc?.name || 'Studio',
      source: loc?.membership_source ?? null,
      primary: r.location_id === primaryId,
    })
  }
  if (primaryId && !out.has(primaryId) && isMemberOfContactStudio(user, primaryId)) {
    const name = (user?.locations || []).find((l) => l?.id === primaryId)?.name || 'Primary studio'
    out.set(primaryId, { locationId: primaryId, name, source: null, primary: true })
  }
  return [...out.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
}

/**
 * Which option the page acts at: the requested one (?studio=) if it is an
 * option, else the viewer's active studio, else the primary, else the first.
 * Anything else in `requested` (another org's studio, garbage) is ignored.
 *
 * @returns {string|null} null when the viewer shares no studio with the person
 */
export function pickActingStudio({ options, requested, activeLocationId, primaryLocationId }) {
  const ids = new Set((options || []).map((o) => o.locationId))
  for (const id of [requested, activeLocationId, primaryLocationId]) {
    if (id && ids.has(id)) return id
  }
  return options?.[0]?.locationId ?? null
}

/**
 * For a contact route that takes an optional `location_id`. Absent, or the
 * primary: the primary, and the route's existing checks judge it as before.
 * Another studio: the caller must belong to it and the person must have a row
 * there; anything else is a 404 (ids are never confirmed), a failed read 503.
 *
 * @returns {Promise<{ locationId: string } | { response: Response }>}
 */
export async function resolveRouteStudio(db, user, contact, requested) {
  const primaryId = contact.location_id
  if (!requested || requested === primaryId) return { locationId: primaryId }
  const notFound = { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  if (!isMemberOfContactStudio(user, requested)) return notFound
  const rel = await hasRelationshipAt(db, contact.id, [requested])
  if (!rel.ok) {
    return { response: NextResponse.json({ success: false, error: 'Could not check this contact\'s studios. Try again.' }, { status: 503 }) }
  }
  if (!rel.at.has(requested)) return notFound
  return { locationId: requested }
}
