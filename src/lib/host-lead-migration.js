// HOST-MASTER.7 — one-off relocation of pre-HOST-MASTER host leads onto the
// org's master location.
//
// WHAT THIS DOES: it MOVES unmatched anchor-location contacts to the owning
// org's master location. It never deletes anything and it never merges
// anything — there is no delete statement in this module.
//
// Before HOST-MASTER, a host signup/registration created its contact at the
// host's own hidden location (`locations.is_host_anchor = true`). Those rows
// are invisible to the operator's normal location-scoped views. This walks
// every anchor location and, for each contact it finds:
//
//   • email does NOT match an existing master contact → MOVE: re-point
//     location_id to the master location and stamp automations_exempt = true
//     (so a historic host lead landing at master does not trip the operator's
//     automations).
//   • email DOES match an existing master contact → REPORTED ONLY, no writes.
//     The collision comes back in `needs_manual_merge` for a human to resolve
//     through the existing POST /api/contacts/merge route.
//
// WHY COLLISIONS ARE NEVER AUTO-MERGED: folding one contact into another means
// re-pointing every child row keyed to that contact — dozens of FK'd tables,
// several with unique constraints, and `deals` carries a trigger that rewrites
// the surviving contact's pipeline_stage_slug. /api/contacts/merge already
// implements that full cross-location re-point and is the only correct place
// for it. A partial re-point followed by a delete would silently destroy
// history through every CASCADE it missed, so this tool does not attempt one.
//
// WHAT MOVES WITH THE CONTACT: `contacts.location_id` and the contact's
// `contact_tags.location_id` — and nothing else. contact_tags is re-pointed
// because tag reads are LOCATION-SCOPED (src/app/api/segments/route.js and
// audience-filter.js both filter contact_tags by the active location), so a
// tag left at the anchor location would silently vanish from master-scoped
// segments and audiences — quietly narrowing every audience built on host:/
// event: tags.
//
// Every other child row (deals, bookings, orders, race_registrations, notes,
// activities, …) INTENTIONALLY keeps its original location. Those are
// historical records, read by contact_id rather than by location, and
// rewriting their location would falsify where the thing actually happened.
// contact_tags is the sole exception because it is the only one that drives a
// location-scoped read.
//
// Idempotent: a relocated contact is no longer at an anchor location, so a
// second run finds nothing to do. Dry-run by default — the caller must
// explicitly opt into writes.

import { logWarn } from '@/lib/log'

const PAGE = 1000 // the supabase-js 1k select cap — always .range()-paginate
const LIST_MAX = 100 // cap the reported id lists; the accompanying counts are exact

/** Lookup key for an email — null when there is nothing usable to match on. */
function emailKey(email) {
  const k = String(email || '').trim().toLowerCase()
  return k || null
}

/**
 * Decide what happens to each anchor-location contact. Pure — no I/O, so the
 * whole decision surface is unit-testable.
 *
 * `needs_manual_merge` is a FLAG, not an operation: the runner performs no
 * writes at all for it.
 *
 * @param {Array<{id: string, email?: string|null}>} anchorContacts
 * @param {Map<string, {id: string}>} masterByEmail lowercased email → master contact
 * @returns {Array<{action: 'needs_manual_merge'|'move'|'skip', id?: string, from?: string, into?: string, reason?: string}>}
 */
export function planHostLeadMigration(anchorContacts, masterByEmail) {
  const plan = []
  for (const c of anchorContacts || []) {
    const key = emailKey(c?.email)
    const match = key ? masterByEmail?.get(key) : null
    // A contact with no usable email can never collide — it always moves.
    if (!match) {
      plan.push({ action: 'move', id: c.id })
      continue
    }
    // Defensive: the row is already the master contact (a re-run mid-flight, or
    // an anchor/master location mix-up). Nothing to do.
    if (match.id === c.id) {
      plan.push({ action: 'skip', id: c.id, reason: 'already master' })
      continue
    }
    plan.push({ action: 'needs_manual_merge', from: c.id, into: match.id })
  }
  return plan
}

/** Range-paginate a whole table past the 1k select cap. */
async function pageAll(db, table, columns, applyFilters) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const base = db.from(table).select(columns)
    const q = applyFilters ? applyFilters(base) : base
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/**
 * Plain move: relocate the contact, exempt it from automations, and carry its
 * tags across. These two UPDATEs are the ONLY writes this module performs.
 *
 * The contacts UPDATE is filtered on location_id as well as id so a contact
 * that moved between the scan and this write (TOCTOU) is left alone rather
 * than dragged back out of wherever it now lives.
 *
 * Throws if the contact itself could not be moved. Returns a message (or null)
 * for a tag re-point failure — that is reported but NOT fatal: the contact has
 * already moved, and re-running the migration re-points the stragglers.
 *
 * @returns {Promise<string|null>} tag re-point failure message, or null
 */
async function moveContact(db, id, masterId, anchorId) {
  const { error } = await db
    .from('contacts')
    .update({ location_id: masterId, automations_exempt: true })
    .eq('id', id)
    .eq('location_id', anchorId)
  if (error) throw new Error(`contacts move: ${error.message}`)

  // Carry the contact's tags to the master location so location-scoped segment
  // and audience reads still see them. This cannot raise 23505: the only
  // unique index on contact_tags is the partial (contact_id, tag) WHERE
  // removed_at IS NULL (mig 085) — location_id is not part of it.
  const { error: tagError } = await db
    .from('contact_tags')
    .update({ location_id: masterId })
    .eq('contact_id', id)
    .eq('location_id', anchorId)
  return tagError ? `contact_tags move: ${tagError.message}` : null
}

/**
 * Walk every host-anchor location and move its contacts onto the owning org's
 * master location. Dry-run by default. Never deletes, never merges.
 *
 * @param {object} db service-role supabase client
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{dry_run: boolean, planned: number, moved: number,
 *   moved_ids: string[], moved_ids_truncated?: boolean,
 *   needs_manual_merge: Array<{anchor_id: string, master_id: string}>,
 *   needs_manual_merge_count: number, needs_manual_merge_truncated?: boolean,
 *   skipped: number, skipped_no_master: number,
 *   errors: Array<{id: string, message: string}>}>}
 *   In dry-run `moved`/`moved_ids` are WOULD-values; the collision fields are
 *   identical either way, since collisions are never acted on. `moved_ids` is
 *   the only record of what a live run changed — there is no undo list.
 */
export async function runHostLeadMigration(db, { dryRun = true } = {}) {
  const summary = {
    dry_run: dryRun,
    planned: 0,
    moved: 0,
    moved_ids: [],
    needs_manual_merge: [],
    needs_manual_merge_count: 0,
    skipped: 0,
    skipped_no_master: 0,
    errors: [],
  }

  const anchors = await pageAll(db, 'locations', 'id, organization_id', (q) =>
    q.eq('is_host_anchor', true)
  )
  if (!anchors.length) return summary

  // Resolve each org's master location once (mig 464).
  const orgIds = [...new Set(anchors.map((a) => a.organization_id).filter(Boolean))]
  const orgs = orgIds.length
    ? await pageAll(db, 'organizations', 'id, master_location_id', (q) => q.in('id', orgIds))
    : []
  const masterByOrg = new Map(orgs.map((o) => [o.id, o.master_location_id]))

  // masterId → (lowercased email → { id }). Cached because several anchor
  // locations can share one org, and refreshed as moves add new emails.
  const masterIndexes = new Map()

  for (const anchor of anchors) {
    const masterId = anchor.organization_id ? masterByOrg.get(anchor.organization_id) : null
    if (!masterId) {
      summary.skipped_no_master += 1
      continue
    }

    const anchorContacts = await pageAll(db, 'contacts', 'id, email', (q) =>
      q.eq('location_id', anchor.id)
    )
    if (!anchorContacts.length) continue

    if (!masterIndexes.has(masterId)) {
      const masterContacts = await pageAll(db, 'contacts', 'id, email', (q) =>
        q.eq('location_id', masterId)
      )
      const index = new Map()
      for (const m of masterContacts) {
        const key = emailKey(m.email)
        if (key && !index.has(key)) index.set(key, { id: m.id })
      }
      masterIndexes.set(masterId, index)
    }
    const masterByEmail = masterIndexes.get(masterId)

    const plan = planHostLeadMigration(anchorContacts, masterByEmail)
    summary.planned += plan.length
    const emailById = new Map(anchorContacts.map((c) => [c.id, emailKey(c.email)]))

    for (const step of plan) {
      if (step.action === 'skip') {
        summary.skipped += 1
        continue
      }

      // Report only — no writes, dry-run or not. Resolve via
      // POST /api/contacts/merge.
      if (step.action === 'needs_manual_merge') {
        summary.needs_manual_merge_count += 1
        if (summary.needs_manual_merge.length < LIST_MAX) {
          summary.needs_manual_merge.push({ anchor_id: step.from, master_id: step.into })
        }
        continue
      }

      // Keep the index honest across anchor locations in the same org: a moved
      // contact now sits at the master location, so a later anchor's
      // same-email contact is a collision to report, not a second move.
      const noteMoved = () => {
        summary.moved += 1
        if (summary.moved_ids.length < LIST_MAX) summary.moved_ids.push(step.id)
        const key = emailById.get(step.id)
        if (key && !masterByEmail.has(key)) masterByEmail.set(key, { id: step.id })
      }

      if (dryRun) {
        noteMoved()
        continue
      }

      // Each move is independently fatal — one bad contact must not abort the
      // run.
      try {
        const tagWarning = await moveContact(db, step.id, masterId, anchor.id)
        noteMoved()
        // The contact moved; only its tags lagged. Report it without
        // un-counting the move — a re-run picks the tags up.
        if (tagWarning) summary.errors.push({ id: step.id, message: tagWarning })
      } catch (e) {
        summary.errors.push({ id: step.id, message: e.message })
      }
    }
  }

  if (summary.needs_manual_merge_count > summary.needs_manual_merge.length) {
    summary.needs_manual_merge_truncated = true
  }
  if (summary.moved > summary.moved_ids.length) {
    summary.moved_ids_truncated = true
  }
  if (summary.needs_manual_merge_count) {
    logWarn('host-lead-migration', 'email collisions need a manual merge', {
      count: summary.needs_manual_merge_count,
    })
  }
  return summary
}
