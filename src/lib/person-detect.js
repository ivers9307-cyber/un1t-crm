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
 * planDetection({ contacts, existingSuggestions })
 *
 * Pure function — builds the candidate list from scratch given contacts and
 * any existing suggestion rows (dismissed or linked pairs are excluded).
 *
 * Returns { candidates, autoLink, review }:
 *   candidates  — full detectCandidates output
 *   autoLink    — high-confidence candidates only
 *   review      — medium + low confidence candidates
 */
export function planDetection({ contacts, existingSuggestions = [] }) {
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

  const candidates = detectCandidates(contacts, { dismissedPairKeys, groupOf })

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

  // 2. Plan
  const { candidates, autoLink, review } = planDetection({ contacts, existingSuggestions })

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

  return {
    dryRun: false,
    counts,
    autoLinked,
    skipped,
    failures,
    totalCandidates: candidates.length,
  }
}
