// src/lib/person-rollup.js — pure rollup helpers for the churn radar
// person-aware dedup layer (CHURN-RADAR-PERSON-AWARE).
//
// No DB access. No imports of db. Pure functions only.
//
// Two exports:
//
//   combineGroupActivity(rows) → Map<groupId, combined>
//     Accumulates activity fields (last_attended_at, last_booked_at,
//     total_attended_30d, total_attended_7d, total_noshow_30d) across
//     all rows that share a person_group_id. Date fields take the MAX
//     (latest non-null ISO string); numeric fields SUM (null treated as 0).
//     Rows without person_group_id are ignored.
//
//   rollupByPerson(sweepRows, { combinedByGroup, primaryByGroup }) → Array
//     Deduplicates a radar sweep's contact rows to one row per person:
//     - Ungrouped rows pass through unchanged (same object reference).
//     - Grouped rows are deduplicated to the primary contact (if present in
//       the sweep) or the first-encountered sweep row (representative fallback).
//     - The kept row gets a shallow-copy with the group's combined activity
//       fields injected (overwriting the single-account values). If the group
//       has no entry in combinedByGroup the row is kept as-is (no injection).
//     - Order of the output mirrors sweepRows (first appearance wins for
//       grouped rows; ungrouped rows stay in place).
//
// Design notes:
//   - "Return the original ISO string, not a Date" — the radar's scorer and
//     UI both expect ISO strings; we never convert to Date objects in the
//     output. Comparisons use Date constructor solely for ordering.
//   - combinedByGroup is built from the FULL group membership (which may
//     include rows not in sweepRows, e.g. a classpass_payg account that the
//     radar sweep didn't load because it only loads member/credit_member
//     statuses). That's why the caller builds it separately from all accounts
//     and passes it in, rather than us recomputing it from sweepRows alone.

/**
 * Accumulate activity fields across all rows sharing a person_group_id.
 *
 * @param {Array<object>} rows - Contact rows; each MAY have person_group_id
 *   plus the activity fields last_attended_at, last_booked_at (ISO strings or
 *   null), total_attended_30d, total_attended_7d, total_noshow_30d (numbers or
 *   null).
 * @returns {Map<string, { last_attended_at, last_booked_at, total_attended_30d,
 *   total_attended_7d, total_noshow_30d }>}
 */
export function combineGroupActivity(rows) {
  const map = new Map()

  for (const row of rows) {
    const groupId = row.person_group_id
    if (!groupId) continue

    if (!map.has(groupId)) {
      map.set(groupId, {
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: 0,
        total_attended_7d: 0,
        total_noshow_30d: 0,
      })
    }

    const acc = map.get(groupId)

    // MAX for date strings — compare via Date, but store the original ISO string
    if (row.last_attended_at != null) {
      if (
        acc.last_attended_at === null ||
        new Date(row.last_attended_at) > new Date(acc.last_attended_at)
      ) {
        acc.last_attended_at = row.last_attended_at
      }
    }

    if (row.last_booked_at != null) {
      if (
        acc.last_booked_at === null ||
        new Date(row.last_booked_at) > new Date(acc.last_booked_at)
      ) {
        acc.last_booked_at = row.last_booked_at
      }
    }

    // SUM for numeric fields; treat null as 0
    acc.total_attended_30d += Number(row.total_attended_30d) || 0
    acc.total_attended_7d += Number(row.total_attended_7d) || 0
    acc.total_noshow_30d += Number(row.total_noshow_30d) || 0
  }

  return map
}

/**
 * Dedup a radar sweep to one row per person, injecting combined activity.
 *
 * @param {Array<object>} sweepRows - The radar's loaded contact rows.
 * @param {object} opts
 * @param {Map<string, object>} opts.combinedByGroup - Map from combineGroupActivity
 *   (built from the FULL group membership; may include rows not in sweepRows).
 * @param {Map<string, string>} opts.primaryByGroup - Map<groupId, primaryContactId>.
 * @returns {Array<object>} New array; ungrouped rows are the same object reference,
 *   kept grouped rows are shallow copies with combined activity injected.
 */
export function rollupByPerson(sweepRows, { combinedByGroup, primaryByGroup }) {
  // Track which group we've already emitted a row for
  const emittedGroups = new Set()
  // For each group, pre-determine which sweep row to keep:
  //   - The one whose id === primaryByGroup.get(groupId) if present in the sweep
  //   - Otherwise the first-encountered sweep row for that group
  // We need a single pass to find the primary-in-sweep, so we pre-scan first.
  const primaryInSweep = new Map() // groupId → row (primary if present, else first)

  for (const row of sweepRows) {
    const groupId = row.person_group_id
    if (!groupId) continue

    const primaryId = primaryByGroup.get(groupId)

    if (!primaryInSweep.has(groupId)) {
      // First row seen for this group — tentative representative
      primaryInSweep.set(groupId, row)
    }

    // If this row IS the primary, it wins unconditionally
    if (primaryId != null && row.id === primaryId) {
      primaryInSweep.set(groupId, row)
    }
  }

  const result = []

  for (const row of sweepRows) {
    const groupId = row.person_group_id

    if (!groupId) {
      // Ungrouped — pass through unchanged (same reference)
      result.push(row)
      continue
    }

    if (emittedGroups.has(groupId)) {
      // Already emitted a representative for this group — skip duplicate
      continue
    }

    const representative = primaryInSweep.get(groupId)
    if (row !== representative) {
      // Not the chosen representative — skip
      continue
    }

    // This is the chosen representative. Emit it (with combined activity if available).
    emittedGroups.add(groupId)

    const combined = combinedByGroup.get(groupId)
    if (combined) {
      // Shallow copy with combined activity injected — do NOT mutate the input row
      result.push({ ...row, ...combined })
    } else {
      // No combined entry (edge case: group not in combinedByGroup) — pass row as-is
      result.push(row)
    }
  }

  return result
}
