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
// Idempotent: a relocated contact is no longer at an anchor location, so a
// second run finds nothing to do. Dry-run by default — the caller must
// explicitly opt into writes.

import { logWarn } from '@/lib/log'

const PAGE = 1000 // the supabase-js 1k select cap — always .range()-paginate
const MANUAL_MERGE_MAX = 100 // cap the reported collision list; the count is what matters

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
 * Plain move: relocate the contact and exempt it from automations. This is the
 * ONLY write this module performs.
 */
async function moveContact(db, id, masterId) {
  const { error } = await db
    .from('contacts')
    .update({ location_id: masterId, automations_exempt: true })
    .eq('id', id)
  if (error) throw new Error(`contacts move: ${error.message}`)
}

/**
 * Walk every host-anchor location and move its contacts onto the owning org's
 * master location. Dry-run by default. Never deletes, never merges.
 *
 * @param {object} db service-role supabase client
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{dry_run: boolean, planned: number, moved: number,
 *   needs_manual_merge: Array<{anchor_id: string, master_id: string}>,
 *   needs_manual_merge_truncated?: boolean, skipped: number,
 *   skipped_no_master: number, errors: Array<{id: string, message: string}>}>}
 *   In dry-run `moved` is a WOULD-count; `needs_manual_merge` is identical
 *   either way, since collisions are never acted on.
 */
export async function runHostLeadMigration(db, { dryRun = true } = {}) {
  const summary = {
    dry_run: dryRun,
    planned: 0,
    moved: 0,
    needs_manual_merge: [],
    skipped: 0,
    skipped_no_master: 0,
    errors: [],
  }
  let collisions = 0

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
        collisions += 1
        if (summary.needs_manual_merge.length < MANUAL_MERGE_MAX) {
          summary.needs_manual_merge.push({ anchor_id: step.from, master_id: step.into })
        }
        continue
      }

      // Keep the index honest across anchor locations in the same org: a moved
      // contact now sits at the master location, so a later anchor's
      // same-email contact is a collision to report, not a second move.
      const noteMoved = () => {
        const key = emailById.get(step.id)
        if (key && !masterByEmail.has(key)) masterByEmail.set(key, { id: step.id })
      }

      if (dryRun) {
        summary.moved += 1
        noteMoved()
        continue
      }

      // Each move is independently fatal — one bad contact must not abort the
      // run.
      try {
        await moveContact(db, step.id, masterId)
        summary.moved += 1
        noteMoved()
      } catch (e) {
        summary.errors.push({ id: step.id, message: e.message })
      }
    }
  }

  if (collisions > summary.needs_manual_merge.length) {
    summary.needs_manual_merge_truncated = true
  }
  if (collisions) {
    logWarn('host-lead-migration', 'email collisions need a manual merge', { count: collisions })
  }
  return summary
}
