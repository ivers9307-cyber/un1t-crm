import { logError, logWarn } from '@/lib/log'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'
import { hasRelationshipAt, contactsAtStudio } from '@/lib/contact-studios'

// Crossover-contact helpers for the studio contacts list.
//
// A "crossover" is a contact whose PRIMARY studio is another one but who has
// a relationship at the active studio: a contact_studios row there (mig 764;
// ORGCONTACTS.2), any kind, active or ended (decision 2). contacts.email is
// unique per organisation, so a person who's already a contact (e.g. a
// Stillorgan member) signing up via another studio's public lead form reuses
// their existing contact and gains a relationship at the new studio.
// These helpers let the destination studio's contacts list surface those
// people with their origin context. The list itself reads
// public.studio_contacts (src/lib/studio-contacts-query.js).

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
// caller may open this contact: they're master, they're a member of its
// PRIMARY studio, or the contact has ANY contact_studios row (active or
// ended: decision 2, ORGCONTACTS.2) at one of the caller's studios where
// they hold Contacts. That is exactly the set RLS admits since mig 765, so
// the list never shows a row this gate then 404s. The owner/master branches
// are pure (no query); only a genuine crossover candidate pays for the probe.
//
// The probe asks only about the studios where the caller holds Contacts
// (contactStudioIds: web OR phone, mig 690's rule), the studios RLS's
// relationship branch reads. A deal-only crossover needs Contacts at the
// studio like every other relationship (mig 762 put deals on that rule).
//
// Security-critical, so it FAILS CLOSED: a missing user/contact, no
// location assignments, Contacts nowhere, or a read error all deny. Reads
// via the service-role client (RLS-bypassing), so this app-layer check IS
// the boundary.
export async function canViewContact(db, user, contact) {
  if (!user || !contact) return false
  if (user.isMaster) return true
  const locIds = (user.locations || []).map((l) => l && l.id).filter(Boolean)
  if (contact.location_id && locIds.includes(contact.location_id)) return true
  if (locIds.length === 0 || !contact.id) return false
  const contactLocIds = contactStudioIds(user, locIds)
  if (contactLocIds.length === 0) return false
  try {
    const rel = await hasRelationshipAt(db, contact.id, contactLocIds)
    if (!rel.ok) {
      logError('contact-crossovers', 'relationship probe failed; refusing', { contactId: contact.id, error: rel.error })
      return false
    }
    return rel.at.size > 0
  } catch (e) {
    logError('contact-crossovers', 'relationship probe threw; refusing', { contactId: contact.id, message: e?.message || String(e) })
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
// limit → 414 (the same wall the phone directory's MOBILE_CROSSOVER_ID_CAP holds).
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

// UN1TRADAR.3 — the radar write routes (action, refresh-member, quarantine,
// lead action, cleanup) accept a contact the ACTIVE studio does not own when
// it has a relationship THERE: any contact_studios row at that one studio
// (ORGCONTACTS.2; a lapsed one included, decision 2). Never the caller's
// other studios. Both fail closed.

/** Does `contactId` have a contact_studios row at `locationId`? Any error → false. */
export async function isCrossoverAt(db, contactId, locationId) {
  if (!contactId || !locationId) return false
  try {
    const r = await contactsAtStudio(db, locationId, { contactIds: [contactId] })
    if (!r.ok) {
      logError('contact-crossovers', 'crossover probe failed; refusing', { locationId, error: r.error })
      return false
    }
    return r.rows.length > 0
  } catch (e) {
    logError('contact-crossovers', 'crossover probe threw; refusing', { locationId, message: e?.message || String(e) })
    return false
  }
}

/**
 * The subset of `contactIds` with a contact_studios row at `locationId`.
 * Any read error → an empty Set: the caller then acts on the contacts it
 * owns only.
 */
export async function crossoverIdsAt(db, contactIds, locationId) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (!locationId || ids.length === 0) return new Set()
  try {
    const r = await contactsAtStudio(db, locationId, { contactIds: ids })
    if (!r.ok) {
      logError('contact-crossovers', 'bulk crossover probe failed; owned contacts only', { locationId, error: r.error })
      return new Set()
    }
    return new Set(r.rows.map((row) => row.contact_id).filter(Boolean))
  } catch (e) {
    logError('contact-crossovers', 'bulk crossover probe threw; owned contacts only', { locationId, message: e?.message || String(e) })
    return new Set()
  }
}
