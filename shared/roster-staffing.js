// ROSTERVIS.1 / MOBILESCHED.2 — roster visibility, the pure half: is a shift
// staffed, and is a period published?
//
// Moved here from src/lib/roster-staffing.js so the mobile Manage mode reads
// the SAME staffing answer as the web calendar (it had its own "below minimum"
// state that counted cancelled assignments as coaches). src/lib/roster-staffing.js
// re-exports every name below and keeps the one IO helper
// (fetchStaffingGapsThisWeek); tests/shared-pair-sync.test.js holds the pair
// in mode `reexport`, so the two import paths cannot drift.
//
// Two review findings, one module:
//
//   1. The calendar, the week banner, the Today chip and the publish preview
//      all noticed a shift only at ZERO coaches. A shift budgeted for two that
//      has one read as fine everywhere except the Studio Overview strip, which
//      has counted below-minimum blocks since SHIFTMIN.1. Live on 2026-09-17:
//      five published shifts at 1 of 2 coaches, invisible on the calendar.
//      `staffingStatus` is the one answer now, shared by every surface.
//
//   2. The manager calendar never said whether the week on screen was
//      published. Its only signal was an in-memory unsaved-changes flag that a
//      reload drops. `periodPublicationStatus` derives it from what the blocks
//      feed already carries (each block's embedded `rosters.status`) plus the
//      draft rosters, which a block cannot carry: a draft roster awaiting
//      approval does NOT tag blocks (only a publish/approve re-tags them), so a
//      draft is invisible from the blocks alone.
//
// Dependency-free: `shared/` is the mobile seam and cannot import src/lib.

// "This assignment still puts a coach on the block." Private, and kept in step
// with isLiveAssignment (src/lib/roster.js) and shared/dashboard-data.js's
// isLiveRow: only `cancelled` is dead; `swapped` is a real shift, and a
// missing status is a legacy live row. Not exported, so it adds no second
// public definition of the name for the pair sweep to reconcile.
const isLive = (a) => a?.status !== 'cancelled'
const countLive = (list) => (Array.isArray(list) ? list : []).filter(isLive).length

/**
 * Staffing status of a shift from its LIVE coach count and its min_coaches.
 *
 *   'empty' — nobody on it. Always flagged, whatever the minimum says: the
 *             calendar has flagged an empty future block red since roster v2,
 *             and a min_coaches of 0 is not a reason to stop.
 *   'short' — at least one coach, fewer than min_coaches.
 *   'ok'    — at or above the minimum.
 *
 * A missing / null / non-numeric minimum is treated as 0 (no minimum), so a
 * block from the coach-facing feed — which never carries min_coaches — can
 * only ever be 'empty' or 'ok'.
 *
 * @param {number} liveCount   live (non-cancelled) assignments on the block
 * @param {number|null|undefined} minCoaches  shift_blocks.min_coaches
 * @returns {'empty'|'short'|'ok'}
 */
export function staffingStatus(liveCount, minCoaches) {
  const count = Number(liveCount) || 0
  if (count <= 0) return 'empty'
  const min = Number(minCoaches) || 0
  return count < min ? 'short' : 'ok'
}

/**
 * The staffing of a block that is today or later. Past blocks return null —
 * a past shift nobody covered is history, not something to act on (the same
 * rule isBlockUnstaffedFuture has always applied).
 *
 * @param {object} block      shift_blocks row: block_date, min_coaches, shift_assignments[]
 * @param {string} todayIso   YYYY-MM-DD
 * @returns {{ status: 'empty'|'short'|'ok', count: number, min: number } | null}
 */
export function futureBlockStaffing(block, todayIso) {
  if (!block || !block.block_date || !todayIso) return null
  if (block.block_date < todayIso) return null
  const count = countLive(block.shift_assignments)
  const min = Number(block.min_coaches) || 0
  return { status: staffingStatus(count, min), count, min }
}

/**
 * Every future block in [from, to] (inclusive, either bound optional) that is
 * empty or below its minimum, in date then start-time order.
 *
 * @returns {Array<{ block: object, status: 'empty'|'short', count: number, min: number }>}
 */
export function staffingGaps(blocks, { from = null, to = null, todayIso } = {}) {
  const gaps = []
  for (const block of blocks || []) {
    if (from && block.block_date < from) continue
    if (to && block.block_date > to) continue
    const s = futureBlockStaffing(block, todayIso)
    if (!s || s.status === 'ok') continue
    gaps.push({ block, ...s })
  }
  gaps.sort((a, b) =>
    a.block.block_date.localeCompare(b.block.block_date)
    || String(a.block.start_time || '').localeCompare(String(b.block.start_time || '')))
  return gaps
}

/**
 * Counts for a banner or a chip.
 * @returns {{ empty: number, short: number, total: number }}
 */
export function countStaffingGaps(blocks, opts = {}) {
  let empty = 0
  let short = 0
  for (const g of staffingGaps(blocks, opts)) {
    if (g.status === 'empty') empty++
    else short++
  }
  return { empty, short, total: empty + short }
}

/**
 * One sentence for a banner or chip: "3 shifts need coaches this week".
 * The breakdown is separate so the caller can style or omit it.
 */
export function staffingGapsHeadline({ total }, suffix = 'this week') {
  return `${total} shift${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} coaches ${suffix}`.trim()
}

export function staffingGapsBreakdown({ empty, short }) {
  const parts = []
  if (empty > 0) parts.push(`${empty} with no coach`)
  if (short > 0) parts.push(`${short} below the minimum`)
  return parts.join(', ')
}

// ─── Publication status ────────────────────────────────────────────────────

export const PUBLICATION_LABELS = {
  published: 'Published',
  pending: 'Draft (awaiting approval)',
  partial: 'Partly published',
  unpublished: 'Not published',
}

/**
 * Is the period on screen published?
 *
 *   'published'   — every block in the period sits on a published roster.
 *   'pending'     — not fully published, and a draft roster (awaiting owner
 *                   approval) overlaps the period.
 *   'partial'     — some blocks published, some not, no draft pending.
 *   'unpublished' — blocks exist and none is published, no draft pending.
 *   'none'        — no blocks in the period and no draft: nothing to say.
 *
 * A block counts as published exactly when the coach feed would show it
 * (`rosters.status === 'published'`), so this chip and what a coach can see
 * cannot disagree. A block on a superseded roster is therefore NOT published.
 *
 * A fully published period with a draft over it stays 'published' — coaches
 * are seeing that roster — and reports `draftPending` so the caller can add
 * that changes are waiting on approval.
 *
 * @param {object} opts
 * @param {Array} opts.blocks        manager blocks feed rows (block_date, rosters: { status })
 * @param {string} opts.periodStart  YYYY-MM-DD inclusive
 * @param {string} opts.periodEnd    YYYY-MM-DD inclusive
 * @param {Array} [opts.draftRosters]  rosters rows: { status, period_start, period_end }
 * @returns {{ status: 'published'|'pending'|'partial'|'unpublished'|'none', draftPending: boolean, blockCount: number, publishedCount: number }}
 */
export function periodPublicationStatus({ blocks, periodStart, periodEnd, draftRosters = [] }) {
  const inPeriod = (blocks || []).filter((b) => b.block_date >= periodStart && b.block_date <= periodEnd)
  const publishedCount = inPeriod.filter((b) => b.rosters?.status === 'published').length

  const draftPending =
    (draftRosters || []).some((r) =>
      (r?.status == null || r.status === 'draft')
      && r.period_start <= periodEnd
      && r.period_end >= periodStart)
    // Defensive: nothing tags a block to a draft today, but if a block ever
    // does carry one it is the same fact.
    || inPeriod.some((b) => b.rosters?.status === 'draft')

  let status
  if (inPeriod.length === 0) status = draftPending ? 'pending' : 'none'
  else if (publishedCount === inPeriod.length) status = 'published'
  else if (draftPending) status = 'pending'
  else if (publishedCount === 0) status = 'unpublished'
  else status = 'partial'

  return { status, draftPending, blockCount: inPeriod.length, publishedCount }
}
