// src/lib/person-detect.js — detection runner for duplicate contact suggestions
// PERSON-LINK.2

import { detectCandidates, pairKey } from './person-match.js'
import { createGroup, addToGroup } from './person-links.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

// ---------------------------------------------------------------------------
// planDetection (pure)
// ---------------------------------------------------------------------------

/**
 * planDetection({ contacts, existingSuggestions, primaryByGroup })
 *
 * Pure function — builds the candidate list from scratch given contacts and
 * any existing suggestion rows (dismissed or linked pairs are excluded).
 *
 * @param {Array}  contacts              - Full contact array for this location
 * @param {Array}  existingSuggestions   - Existing suggestion rows (for dismissed/linked exclusion)
 * @param {Map}    primaryByGroup        - groupId → primaryContactId (from person_groups)
 *
 * Returns { candidates, autoLink, review }:
 *   candidates  — full detectCandidates output
 *   autoLink    — high-confidence candidates only
 *   review      — medium + low confidence candidates
 */
export function planDetection({ contacts, existingSuggestions = [], primaryByGroup = new Map() }) {
  // Build dismissedPairKeys: skip pairs that are already decided
  const dismissedPairKeys = new Set(
    existingSuggestions
      .filter((s) => s.status === 'dismissed' || s.status === 'linked')
      .map((s) => pairKey(s.contact_id_a, s.contact_id_b))
  )

  // Build groupOf: contactId → groupId for contacts already in a group
  const groupOf = new Map()
  for (const c of contacts) {
    if (c.person_group_id) {
      groupOf.set(c.id, c.person_group_id)
    }
  }

  const candidates = detectCandidates(contacts, { dismissedPairKeys, groupOf, primaryByGroup })

  const autoLink = candidates.filter((c) => c.confidence === 'high')
  const review = candidates.filter((c) => c.confidence !== 'high')

  return { candidates, autoLink, review }
}

// ---------------------------------------------------------------------------
// Paginated load helpers
// ---------------------------------------------------------------------------

async function loadContactsForLocation(db, locationId) {
  const rows = []
  let pageStart = 0
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select('id, name, first_name, last_name, phone, wa_phone, glofox_membership_status, person_group_id')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) throw error
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    if (rows.length >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }
  return rows
}

async function loadSuggestionsForLocation(db, locationId) {
  const rows = []
  let pageStart = 0
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('person_link_suggestions')
      .select('id, contact_id_a, contact_id_b, status')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) throw error
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    if (rows.length >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }
  return rows
}

// ---------------------------------------------------------------------------
// runDetection (IO)
// ---------------------------------------------------------------------------

/**
 * runDetection(db, { locationId, commit = false, actorId })
 *
 * Dry-run (commit=false):
 *   Returns { dryRun:true, counts, autoLinkCount, totalCandidates, sample }
 *   without writing anything.
 *
 * Commit (commit=true):
 *   1. Upserts all candidates into person_link_suggestions (ignoreDuplicates).
 *   2. Links high-confidence pairs via createGroup / addToGroup.
 *   3. Updates linked suggestion rows to status='linked'.
 *   Returns { dryRun:false, counts, autoLinked, skipped, failures, totalCandidates }
 */
export async function runDetection(db, { locationId, commit = false, actorId }) {
  // 1. Load data
  const [contacts, existingSuggestions] = await Promise.all([
    loadContactsForLocation(db, locationId),
    loadSuggestionsForLocation(db, locationId),
  ])

  // 1b. Build primaryByGroup from the loaded contacts' person_group_ids
  let primaryByGroup = new Map()
  const groupIds = [...new Set(contacts.map((c) => c.person_group_id).filter(Boolean))]
  if (groupIds.length > 0) {
    try {
      const { data: groups, error } = await db
        .from('person_groups')
        .select('id, primary_contact_id')
        .in('id', groupIds)
      if (!error && Array.isArray(groups)) {
        for (const g of groups) {
          if (g.primary_contact_id) {
            primaryByGroup.set(g.id, g.primary_contact_id)
          }
        }
      }
    } catch (e) {
      // Degrade safely: detection still runs without primaryByGroup
      console.error('[person-detect] primaryByGroup fetch error:', e?.message || e)
    }
  }

  // 2. Plan
  const { candidates, autoLink, review } = planDetection({ contacts, existingSuggestions, primaryByGroup })

  const counts = {
    high: autoLink.length,
    medium: review.filter((c) => c.confidence === 'medium').length,
    low: review.filter((c) => c.confidence === 'low').length,
  }

  // 3. Dry-run — return without writing
  if (!commit) {
    return {
      dryRun: true,
      counts,
      autoLinkCount: autoLink.length,
      totalCandidates: candidates.length,
      sample: candidates.slice(0, 25),
    }
  }

  // 4. Commit path

  // 4a. Upsert ALL candidates into person_link_suggestions
  if (candidates.length > 0) {
    const suggestionRows = candidates.map((c) => ({
      location_id: locationId,
      contact_id_a: c.aId,
      contact_id_b: c.bId,
      match_method: c.method,
      confidence: c.confidence,
      reason: c.reason,
      status: 'pending',
    }))

    try {
      await db
        .from('person_link_suggestions')
        .upsert(suggestionRows, { onConflict: 'contact_id_a,contact_id_b', ignoreDuplicates: true })
    } catch (e) {
      // Non-fatal: suggestions are advisory; linking still proceeds
      console.error('[person-detect] suggestion upsert error:', e?.message || e)
    }
  }

  // 4b. Build a fast groupOf map from the loaded contacts
  const groupOfMap = new Map()
  for (const c of contacts) {
    if (c.person_group_id) {
      groupOfMap.set(c.id, c.person_group_id)
    }
  }

  // 4c. Link high-confidence pairs (best-effort per pair)
  let autoLinked = 0
  let skipped = 0
  let failures = 0

  for (const candidate of autoLink) {
    const { aId, bId, method, confidence } = candidate

    const gA = groupOfMap.get(aId)
    const gB = groupOfMap.get(bId)

    // Both already in the same group — already linked, skip
    if (gA !== undefined && gB !== undefined && gA === gB) {
      skipped++
      continue
    }

    // Both in DIFFERENT groups — do not auto-merge groups
    if (gA !== undefined && gB !== undefined && gA !== gB) {
      skipped++
      continue
    }

    try {
      if (gA === undefined && gB === undefined) {
        // Both ungrouped → create a new group
        const result = await createGroup(db, {
          contactIds: [aId, bId],
          method,
          confidence,
          actorId,
          locationId,
        })
        // Update our local groupOf map so subsequent pairs see the new group
        const newGroupId = result?.group?.id
        if (newGroupId) {
          groupOfMap.set(aId, newGroupId)
          groupOfMap.set(bId, newGroupId)
        } else {
          // createGroup succeeded (didn't throw) but returned no group id —
          // the pair cannot be tracked in-memory, so a later pair touching
          // either contact would wrongly call createGroup again. Treat this
          // as a failure so the caller can investigate.
          console.error(
            `[person-detect] createGroup returned no group id for pair ${aId}:${bId}; result:`,
            result
          )
          failures++
          continue
        }
      } else if (gA !== undefined) {
        // aId is grouped, bId is not
        await addToGroup(db, {
          groupId: gA,
          contactIds: [bId],
          method,
          confidence,
          actorId,
        })
        groupOfMap.set(bId, gA)
      } else {
        // bId is grouped, aId is not
        await addToGroup(db, {
          groupId: gB,
          contactIds: [aId],
          method,
          confidence,
          actorId,
        })
        groupOfMap.set(aId, gB)
      }

      // Mark the suggestion row as linked
      try {
        await db
          .from('person_link_suggestions')
          .update({
            status: 'linked',
            decided_by: actorId,
            decided_at: new Date().toISOString(),
          })
          .eq('contact_id_a', aId)
          .eq('contact_id_b', bId)
      } catch (e) {
        // Non-fatal: suggestion status update is advisory
        console.error('[person-detect] suggestion status update error:', e?.message || e)
      }

      autoLinked++
    } catch (e) {
      // Best-effort: one bad pair must not abort the whole commit
      console.error(`[person-detect] link error for pair ${aId}:${bId}:`, e?.message || e)
      failures++
    }
  }

  // 4d. Supersede redundant pending suggestions (both endpoints already in same group)
  const superseded = await supersedeRedundantPending(db, locationId)

  return {
    dryRun: false,
    counts,
    autoLinked,
    skipped,
    failures,
    totalCandidates: candidates.length,
    superseded,
  }
}

// ---------------------------------------------------------------------------
// supersedeRedundantPending (IO, commit-only)
// ---------------------------------------------------------------------------

/**
 * supersedeRedundantPending(db, locationId)
 *
 * Finds pending person_link_suggestions where BOTH contact endpoints already
 * share the same person_group_id (i.e. they've been auto-linked by this or
 * a previous run). Marks those suggestions status='linked' so they stop
 * cluttering the review queue.
 *
 * Best-effort: any error is caught and logged; never fails the caller.
 * Returns a count of rows superseded (0 on error or nothing to supersede).
 */
async function supersedeRedundantPending(db, locationId) {
  try {
    // Load all pending suggestions for this location
    const pendingRows = []
    let pageStart = 0
    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
      const { data: page, error } = await db
        .from('person_link_suggestions')
        .select('id, contact_id_a, contact_id_b')
        .eq('location_id', locationId)
        .eq('status', 'pending')
        .order('id', { ascending: true })
        .range(pageStart, pageEnd)
      if (error) throw error
      if (!Array.isArray(page) || page.length === 0) break
      pendingRows.push(...page)
      if (page.length < PAGE_SIZE) break
      if (pendingRows.length >= HARD_LIMIT) break
      pageStart += PAGE_SIZE
    }

    if (pendingRows.length === 0) return 0

    // Collect distinct contact ids across all pending rows
    const contactIdSet = new Set()
    for (const row of pendingRows) {
      contactIdSet.add(row.contact_id_a)
      contactIdSet.add(row.contact_id_b)
    }
    const contactIds = [...contactIdSet]

    // Fetch current person_group_id for each contact
    const { data: contactRows, error: cErr } = await db
      .from('contacts')
      .select('id, person_group_id')
      .in('id', contactIds)
    if (cErr) throw cErr

    const groupOfContact = new Map()
    for (const c of contactRows || []) {
      if (c.person_group_id) groupOfContact.set(c.id, c.person_group_id)
    }

    // Find pending suggestions where both endpoints share the same group
    const redundantIds = []
    for (const row of pendingRows) {
      const gA = groupOfContact.get(row.contact_id_a)
      const gB = groupOfContact.get(row.contact_id_b)
      if (gA && gB && gA === gB) {
        redundantIds.push(row.id)
      }
    }

    if (redundantIds.length === 0) return 0

    // Mark redundant rows as linked (superseded — already in the same person group)
    const decidedAt = new Date().toISOString()
    const { error: uErr } = await db
      .from('person_link_suggestions')
      .update({ status: 'linked', decided_at: decidedAt })
      .in('id', redundantIds)
    if (uErr) throw uErr

    return redundantIds.length
  } catch (e) {
    // Best-effort: cleanup failure must never fail the commit
    console.error('[person-detect] supersedeRedundantPending error:', e?.message || e)
    return 0
  }
}
