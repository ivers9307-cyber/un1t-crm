// Crossover-contact helpers for the studio contacts list.
//
// A "crossover" is a contact OWNED by a different studio that nonetheless
// has a deal at the active studio. contacts.email is globally unique, so a
// person who's already a contact (e.g. a Stillorgan member) signing up via
// another studio's public lead form reuses their existing contact + gets a
// deal at the new studio. These helpers let the destination studio's
// contacts list surface those leads with their origin context.

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

// Distinct contact_ids that have ANY deal at this location. Paginated to
// respect PostgREST's 1k cap. Best-effort — returns [] on error/missing args.
export async function crossoverContactIds(db, locationId) {
  if (!db || !locationId) return []
  const ids = new Set()
  let pageStart = 0
  try {
    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
      const { data, error } = await db
        .from('deals')
        .select('contact_id')
        .eq('location_id', locationId)
        .not('contact_id', 'is', null)
        .order('contact_id', { ascending: true })
        .range(pageStart, pageEnd)
      if (error || !Array.isArray(data) || data.length === 0) break
      for (const r of data) if (r.contact_id) ids.add(r.contact_id)
      if (data.length < PAGE_SIZE || ids.size >= HARD_LIMIT) break
      pageStart += PAGE_SIZE
    }
  } catch {
    return [...ids]
  }
  return [...ids]
}

// For the crossover contacts within `contacts` (owned elsewhere than
// activeLocationId), fetch their home-studio name + active tags. Returns
// { [contactId]: { homeStudio, tags } }. Best-effort — {} on error / none.
export async function fetchCrossoverContext(db, contacts, activeLocationId) {
  const crossovers = (Array.isArray(contacts) ? contacts : []).filter(
    (c) => c && c.location_id && activeLocationId && c.location_id !== activeLocationId
  )
  if (crossovers.length === 0) return {}
  const ids = crossovers.map((c) => c.id)
  const locIds = [...new Set(crossovers.map((c) => c.location_id))]
  try {
    const [{ data: locs }, { data: tagRows }] = await Promise.all([
      db.from('locations').select('id, name').in('id', locIds),
      db.from('contact_tags').select('contact_id, tag').in('contact_id', ids).is('removed_at', null),
    ])
    const locName = new Map((locs || []).map((l) => [l.id, l.name]))
    const tagsByContact = {}
    for (const r of tagRows || []) (tagsByContact[r.contact_id] ||= []).push(r.tag)
    const ctx = {}
    for (const c of crossovers) {
      ctx[c.id] = { homeStudio: locName.get(c.location_id) || 'Other studio', tags: tagsByContact[c.id] || [] }
    }
    return ctx
  } catch {
    return {}
  }
}

// Authorisation gate for the contact DETAIL view. Returns true when the
// caller may open this contact: they're master, they OWN it (its location
// is one of theirs), or it's a crossover INTO one of their studios (the
// contact has a deal there). The crossover branch is what keeps this in
// step with the list's owned ∪ crossover visibility — gating the detail
// page strictly by ownership would 404 every crossover row an operator
// can see in the list and click. The owner/master branches are pure (no
// query); only a genuine crossover candidate pays for the deal probe.
//
// Security-critical, so it FAILS CLOSED: a missing user/contact, no
// location assignments, or a query error all deny. Reads via the
// service-role client (RLS-bypassing), so this app-layer check IS the
// boundary.
export async function canViewContact(db, user, contact) {
  if (!user || !contact) return false
  if (user.isMaster) return true
  const locIds = (user.locations || []).map((l) => l && l.id).filter(Boolean)
  if (contact.location_id && locIds.includes(contact.location_id)) return true
  if (locIds.length === 0 || !contact.id) return false
  try {
    const { data } = await db
      .from('deals')
      .select('id')
      .eq('contact_id', contact.id)
      .in('location_id', locIds)
      .limit(1)
    return Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}
