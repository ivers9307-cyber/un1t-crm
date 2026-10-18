import { logError, logWarn } from '@/lib/log'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'

// Crossover-contact helpers for the studio contacts list.
//
// A "crossover" is a contact OWNED by a different studio that nonetheless
// has a deal, an ACTIVE contact_memberships row (UN1TDUAL, mig 731) or a
// un1t_clients row (any un1t status; UN1TDUAL.4, mig 732) at the active
// studio. contacts.email is globally unique, so a person who's
// already a contact (e.g. a Stillorgan member) signing up via another
// studio's public lead form reuses their existing contact + gets a deal at
// the new studio, a Stillorgan member who also buys a Hatch Street
// membership keeps their one contact + gains an active membership there,
// and a Hatch un1t.online client, lapsed or not, is linked to that one
// contact by the un1t sync.
// These helpers let the destination studio's contacts list surface those
// people with their origin context.

// Cap on the crossover id list. The contacts list query builds an
// `id.in.(...)` filter from these ids; PostgREST sends that as a GET URL, so
// an unbounded list overruns Cloudflare's URI limit → 414. Genuine crossovers
// are a small minority, so this is a safety backstop, not an expected ceiling.
export const CROSSOVER_ID_CAP = 100

// Contact ids that are GENUINE crossovers at this location: a contact with a
// deal, an ACTIVE membership or a un1t_clients row here but OWNED by a
// DIFFERENT studio. Computed by the crossover_contact_ids RPC (mig 251,
// widened to active memberships by mig 731 and to un1t clients by mig 732)
// — a server-side join, so the location's (possibly enormous: 8k+
// at Stillorgan) OWN deal-holder set never travels back as an id.in() URL.
// The location's own contacts are deliberately excluded: the list query
// already matches them via location_id = L, so including them in id.in() was
// pure redundancy AND the source of the 414.
// Best-effort — returns [] on error/missing args (the list then falls back to
// owned-only).
export async function crossoverContactIds(db, locationId) {
  if (!db || !locationId) return []
  try {
    const { data, error } = await db.rpc('crossover_contact_ids', { loc: locationId })
    if (error || !Array.isArray(data)) return []
    const ids = data.map((r) => r && r.contact_id).filter(Boolean)
    if (ids.length > CROSSOVER_ID_CAP) {
      logWarn('contact-crossovers', 'crossover ids exceed cap; truncating for URL-length safety', {
        locationId,
        total: ids.length,
        cap: CROSSOVER_ID_CAP,
      })
      return ids.slice(0, CROSSOVER_ID_CAP)
    }
    return ids
  } catch {
    return []
  }
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
// is one of theirs), the contact holds an ACTIVE membership at one of the
// caller's studios where they hold Contacts (UN1TDUAL.2), one of those
// studios lists it as a un1t.online client (UN1TDUAL.4), or it's a
// crossover INTO one of their studios (the contact has a deal there). The
// membership, client and deal branches are what keep this in step with the
// list's owned ∪ crossover visibility (crossover_contact_ids returns all
// three since mig 732) — gating the detail page strictly by ownership would
// 404 every crossover row an operator can see in the list and click. The
// owner/master branches are pure (no query); only a genuine crossover
// candidate pays for the probes.
//
// The membership and client probes mirror RLS (migs 731/732), which admits
// them only at studios in private.auth_contact_read_location_ids(): where
// the caller holds Contacts on the web OR the phone. So they probe only
// those studios (contactStudioIds), judged by the same resolvers mig 690's
// parity test checks that SQL against. The owned branch and the deal probe
// keep their older studio-membership rule (unchanged here).
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
  // The caller's studios where they hold Contacts (web or phone), the set
  // RLS's membership/client branch reads. Empty → both probes are skipped.
  const contactLocIds = contactStudioIds(user, locIds)
  try {
    if (contactLocIds.length > 0) {
      if (await probeMembershipOrClient(db, contact.id, contactLocIds)) return true
    }

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

/** The caller's studios where they hold Contacts, web OR phone (mig 690's rule). */
export function contactStudioIds(user, locIds) {
  return locIds.filter(
    (id) =>
      hasPermissionForLocation(user, id, 'contacts') ||
      hasMobilePermissionForLocation(user, id, 'contacts')
  )
}

/**
 * True when the contact has an ACTIVE membership or a un1t_clients row at one
 * of `locIds`. A read error is logged and treated as "no" for that probe
 * only; it never grants. A thrown read propagates (the caller denies).
 */
async function probeMembershipOrClient(db, contactId, locIds) {
  // UN1TDUAL.2 — an ACTIVE membership at one of the caller's Contacts
  // studios opens the contact even though its row is owned elsewhere (a
  // Stillorgan member who also holds a Hatch Street membership). Mirrors the
  // RLS / crossover widening in mig 731. An ended membership grants nothing.
  // A read error denies only THIS branch (logged, no PII), then falls
  // through to the deal probe, so a contact_memberships outage cannot hide
  // a deal crossover. It never grants.
  const { data: memberships, error: membershipErr } = await db
    .from('contact_memberships')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .in('location_id', locIds)
    .limit(1)
  if (membershipErr) {
    logError('contact-crossovers', 'membership probe failed; falling through to the client probe', {
      contactId,
      code: membershipErr.code,
      message: membershipErr.message,
    })
  } else if (Array.isArray(memberships) && memberships.length > 0) {
    return true
  }

  // UN1TDUAL.4 — a contact the studio's un1t.online account lists as a
  // client (a un1t_clients row at one of the caller's Contacts studios
  // linked to this contact) opens it too, whatever the un1t status: lapsed
  // clients still get that studio's marketing. Mirrors mig 732. The live row is
  // read, so a relink by the un1t sync moves access with it. Same failure
  // rule as the membership probe: an error is logged (no PII) and falls
  // through to the deal probe; it never grants.
  const { data: clients, error: clientErr } = await db
    .from('un1t_clients')
    .select('id')
    .eq('contact_id', contactId)
    .in('location_id', locIds)
    .limit(1)
  if (clientErr) {
    logError('contact-crossovers', 'un1t client probe failed; falling through to deal probe', {
      contactId,
      code: clientErr.code,
      message: clientErr.message,
    })
  } else if (Array.isArray(clients) && clients.length > 0) {
    return true
  }
  return false
}

// ── LISTFLAG.1 — "this person is also on another studio's list" ──────────
//
// Deliberately NOT the crossover mechanism above, and the gap between the two
// is the whole reason this exists. `crossover_contact_ids` keys on **deals,
// ACTIVE memberships or un1t.online clients** (deals only until mig 731;
// clients since mig 732), so at Hatch Street it
// found exactly ONE person when this was written — while 33 Stillorgan-owned
// contacts had registered interest in Hatch and were invisible in every list
// view. Those 33 existed only as `contact_location_preferences` rows: the
// per-location comms model, where a row's PRESENCE is what makes a location
// allowed to mail that person at all. Flagging deals or memberships answers
// "who has bought here"; flagging preference rows answers "who is on this
// list", which is the question an operator staring at a pre-opening waitlist
// is actually asking.
//
// Returns { [contactId]: [{ id, name, emailMarketing }] } — every ACTIVE,
// non-host-anchor studio the contact holds a preferences row at, EXCLUDING
// their own home studio (true of everyone, so it carries no information) and
// the studio being viewed (the crossover pill already names that one). Sorted
// by name so pills keep a stable order between renders.
//
// `emailMarketing` rides along because the flag's whole audience is an
// operator about to send something: "on the Hatch list" and "on the Hatch
// list but opted out" must not look identical.
//
// Best-effort — {} on any error. A decorative pill must never take the
// contacts list down with it.

// Ids per `.in()`. Matches attachLinkedCounts' CHUNK: PostgREST sends the
// filter as a GET URL, and an unbounded id list overruns Cloudflare's URI
// limit → 414. This is the same wall CROSSOVER_ID_CAP was built for.
const LIST_FLAG_ID_CHUNK = 120

// Rows per page WITHIN a chunk. The 1,000-row select cap applies regardless
// of `.limit()`, and a chunk can legitimately exceed it (120 contacts x N
// studios), so the read is `.range()`-paginated under a total order. Today
// the inner loop runs exactly once; it stays correct as studios are added.
const LIST_FLAG_ROW_PAGE = 1000

export async function fetchListMembershipFlags(db, contacts, activeLocationId) {
  const list = (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.id)
  if (list.length === 0) return {}

  // A contact whose home studio we cannot see is SKIPPED, not flagged. Both
  // callers select `location_id` today, but if either field list is ever
  // narrowed, the alternative is a pill naming the contact's OWN studio —
  // wrong, and wrong in the quiet way that survives a review.
  const homeById = new Map(
    list.filter((c) => c.location_id).map((c) => [c.id, c.location_id])
  )
  const ids = [...homeById.keys()]
  if (ids.length === 0) return {}

  try {
    const prefRows = []
    for (let i = 0; i < ids.length; i += LIST_FLAG_ID_CHUNK) {
      const slice = ids.slice(i, i + LIST_FLAG_ID_CHUNK)
      for (let from = 0; ; from += LIST_FLAG_ROW_PAGE) {
        // (contact_id, location_id) is the table's identity, so this order is
        // total — without one, `.range()` paging can repeat or skip rows.
        const { data, error } = await db
          .from('contact_location_preferences')
          .select('contact_id, location_id, email_marketing')
          .in('contact_id', slice)
          .order('contact_id', { ascending: true })
          .order('location_id', { ascending: true })
          .range(from, from + LIST_FLAG_ROW_PAGE - 1)
        if (error || !Array.isArray(data)) return {}
        prefRows.push(...data)
        if (data.length < LIST_FLAG_ROW_PAGE) break
      }
    }

    // Drop the two uninformative cases before we bother naming anything.
    const relevant = prefRows.filter(
      (r) =>
        r &&
        r.location_id &&
        r.location_id !== homeById.get(r.contact_id) &&
        r.location_id !== activeLocationId
    )
    if (relevant.length === 0) return {}

    // Only real, operator-facing studios become pills. A host-anchor or a
    // deactivated location holding a stray preferences row is noise on a row
    // the operator is trying to read at a glance.
    const locIds = [...new Set(relevant.map((r) => r.location_id))]
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, name')
      .in('id', locIds)
      .eq('active', true)
      .eq('is_host_anchor', false)
    if (locErr || !Array.isArray(locs)) return {}
    const locName = new Map(locs.map((l) => [l.id, l.name]))

    const flags = {}
    for (const r of relevant) {
      const name = locName.get(r.location_id)
      if (!name) continue
      ;(flags[r.contact_id] ||= []).push({
        id: r.location_id,
        name,
        emailMarketing: r.email_marketing === true,
      })
    }
    for (const k of Object.keys(flags)) {
      flags[k].sort((a, b) => a.name.localeCompare(b.name))
    }
    return flags
  } catch {
    return {}
  }
}
