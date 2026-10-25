// BRIEFING.2 — IO for the "Studio pulse" strip in the morning
// briefing. Assembles the bundle shapePulseMetrics() (pure, in
// morning-briefing.js) turns into rendered metrics:
//
//   counts          live membership split via the seam's membershipCounts
//                   (computeMembershipCounts at a Glofox studio)
//                   (same definitions as the Business dashboard +
//                   monthly membership_snapshots — apples to apples)
//   radar           live radar summary (paused = Glofox state
//                   'paused'; overdue = state 'locked' i.e. payment
//                   failed — NOT the stale glofox_invoices table)
//   prevMembership  comparator membership_snapshots row: the last
//                   snapshot BEFORE this month (true month-vs-month),
//                   falling back to the oldest available so a young
//                   table still yields an honest, labelled window
//   prevChurn       same rule against churn_radar_snapshots (weekly)
//
// Fail-soft: returns null on any failure — the briefing renders
// without the strip rather than not at all.

import { firstOfMonth } from '@/lib/membership-snapshot'
import { loadRadar } from '@/lib/churn-radar-data'
import { radarReadsFor } from '@/lib/membership/reads/index'

const COMPARATOR_MIN_AGE_MS = 30 * 86_400_000

// UN1TRADAR.2 — the oldest row is read FIRST: while it is under 30 days old
// the location has no month to compare with (Hatch's un1t-shaped history
// starts 2026-10-18), so there is no comparator and the "vs" line is hidden.
// Otherwise: the last row strictly before this month's first day; else the
// oldest row available. `table`/`dateCol` differ per snapshot family but the
// rule is identical (Stillorgan's history starts in June, so it is unchanged).
export async function pickComparator(db, table, dateCol, cols, locationId, monthStartIso, nowMs = Date.now()) {
  const oldest = await db
    .from(table)
    .select(cols)
    .eq('location_id', locationId)
    .order(dateCol, { ascending: true })
    .limit(1)
    .maybeSingle()
  const oldestMs = Date.parse(oldest.data?.[dateCol])
  if (!Number.isFinite(oldestMs) || nowMs - oldestMs < COMPARATOR_MIN_AGE_MS) return null
  const before = await db
    .from(table)
    .select(cols)
    .eq('location_id', locationId)
    .lt(dateCol, monthStartIso)
    .order(dateCol, { ascending: false })
    .limit(1)
    .maybeSingle()
  if (before.data) return before.data
  return oldest.data || null
}

/**
 * Assemble the pulse bundle for one location. Null on failure.
 */
export async function fetchStudioPulse(db, locationId, nowMs = Date.now()) {
  if (!locationId) return null
  try {
    const monthStartIso = firstOfMonth(new Date(nowMs))
    // UN1TRADAR.2 — counts through the membership seam by source key (the
    // Glofox adapter's membershipCounts is computeMembershipCounts)
    const { reads } = await radarReadsFor(db, locationId)
    if (typeof reads.membershipCounts !== 'function') return null
    const [counts, radarRes, prevMembership, prevChurn] = await Promise.all([
      reads.membershipCounts(db, locationId),
      loadRadar(db, locationId, nowMs),
      pickComparator(db, 'membership_snapshots', 'snapshot_date',
        'snapshot_date, monthly_recurring, class_packs, payg, total_members',
        locationId, monthStartIso, nowMs),
      pickComparator(db, 'churn_radar_snapshots', 'captured_at',
        'captured_at, paused, overdue',
        locationId, monthStartIso, nowMs),
    ])
    const s = radarRes?.summary || {}
    return {
      counts,
      radar: {
        paused: s.paused || 0, overdue: s.overdue || 0, overdueValueCents: s.overdueValueCents || 0,
        overdueValueEstimated: s.overdueValueEstimated === true,
        arrearsUnavailable: s.unpaidCharges === null,
      },
      prevMembership,
      prevChurn,
    }
  } catch (e) {
    console.warn(`[studio-pulse] failed for ${locationId}: ${e?.message || e}`)
    return null
  }
}
