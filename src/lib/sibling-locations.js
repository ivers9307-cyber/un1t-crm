// ORGSCOPE.1 — the organisation boundary for every "this person's shifts at
// OTHER studios" read.
//
// Nothing in profile_locations (or mig 417) keeps a person inside one
// organisation, and those reads print the other shift's template name, times
// and studio name. So "another studio" must mean "another studio of THIS
// organisation" (locations.organization_id, NOT NULL since mig 079); an open
// "any location" or "not this location" filter shows one tenant another
// tenant's roster through any coach the two share.
//
// Never throws, and never answers wider than it can prove: an error comes back
// with NO ids, so a caller that fails soft narrows to its own studio. An
// organisation has a handful of locations, so the read does not page.

/**
 * The other studios in `locationId`'s organisation (never `locationId` itself).
 * @returns {Promise<{ ids: string[], error: { message: string } | null }>}
 */
export async function siblingLocationIds(db, locationId) {
  if (!locationId) return { ids: [], error: { message: 'no location id' } }
  try {
    const { data: loc, error: locErr } = await db
      .from('locations')
      .select('id, organization_id')
      .eq('id', locationId)
      .maybeSingle()
    if (locErr) return { ids: [], error: locErr }
    if (!loc?.organization_id) return { ids: [], error: { message: 'location not found or has no organization_id' } }

    const { data: siblings, error: sibErr } = await db
      .from('locations')
      .select('id')
      .eq('organization_id', loc.organization_id)
      .neq('id', locationId)
    if (sibErr) return { ids: [], error: sibErr }
    return { ids: (siblings || []).map((l) => l.id).filter(Boolean), error: null }
  } catch (e) {
    return { ids: [], error: { message: e?.message || 'sibling lookup threw' } }
  }
}
