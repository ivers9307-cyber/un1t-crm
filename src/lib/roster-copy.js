// COPYMODES.1 — the two ways to copy a roster period forward.
//
//   exact    ("Copy week", a carbon copy): every live source assignment lands
//            on the mapped day with the times it ACTUALLY had (block-level
//            edits and per-coach overrides both), its partial_reason and its
//            notes. Every staffed source block is ensured on the target, and
//            an empty one too where its template runs on the target weekday. A target block that has to be created takes
//            the SOURCE block's times and capacity, not the template's.
//   template ("Copy from template"): the same coaches go onto the same
//            template slot (template_id + weekday) at the template's defined
//            times (an override only where the target block was hand-edited
//            away from them). No partial_reason, no notes. A source
//            assignment whose template is inactive, or no longer runs on
//            that weekday, is skipped and counted.
//
// Both modes insert only (COPYFIX.1, via bulkUpsertShiftAssignments): a coach
// already on the target keeps their times, notes and status.
//
// The reads (fetchSourceBlocks, and COPYLEAVE.1's fetchApprovedLeave) are the
// only I/O here. Everything that decides what gets written (buildCopyPlan +
// the date mappers) is pure, so both modes are unit-testable without a
// Supabase mock. Dates are YYYY-MM-DD calendar
// strings throughout; they are only ever turned into local-midnight Dates and
// back through local components, never toISOString() (BST, see CLAUDE.md).

import { isLiveAssignment, WEEKDAY_CODES } from './roster'

export const COPY_MODES = ['exact', 'template']

// PostgREST caps every select at 1,000 rows regardless of .limit(); a busy
// location's month of blocks can pass that, so the source read pages.
const PAGE_SIZE = 1000

/**
 * Every shift_block in [startDate, endDate] at the location, each with its
 * template and its assignments embedded. Paged by .range() over a total
 * order, so a month with more than 1,000 blocks is read in full rather than
 * silently truncated. (The embedded assignments are not subject to the
 * top-level row cap.)
 *
 * @returns {Promise<{ blocks: Array<object>, error: object|null }>}
 */
export async function fetchSourceBlocks(db, { locationId, startDate, endDate }) {
  const blocks = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('shift_blocks')
      // Literal on purpose: check:select-columns only resolves literal selects.
      .select(`
        id, template_id, block_date, start_time, end_time, min_coaches, max_coaches,
        shift_templates ( id, active, days_of_week, start_time, end_time, min_coaches, max_coaches ),
        shift_assignments ( profile_id, status, notes, partial_reason, start_time_override, end_time_override )
      `)
      .eq('location_id', locationId)
      .gte('block_date', startDate)
      .lte('block_date', endDate)
      .order('block_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { blocks: [], error }
    const page = data || []
    blocks.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return { blocks, error: null }
}

/**
 * COPYLEAVE.1 — APPROVED time off, of any type, for these coaches that
 * overlaps [startDate, endDate] (the TARGET period). Filtered by PERSON, not by
 * location: leave covers the person (LEAVE.2), so a coach who filed from
 * another studio is still off here. Paged like fetchSourceBlocks.
 *
 * @returns {Promise<{ leave: Array<object>, error: object|null }>}
 */
export async function fetchApprovedLeave(db, { profileIds, startDate, endDate }) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (ids.length === 0) return { leave: [], error: null }
  const leave = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('time_off_requests')
      // Literal on purpose: check:select-columns only resolves literal selects.
      .select('id, profile_id, start_date, end_date, status')
      .in('profile_id', ids)
      .eq('status', 'approved')
      .lte('start_date', endDate)
      .gte('end_date', startDate)
      .order('start_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { leave: [], error }
    const page = data || []
    leave.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return { leave, error: null }
}

/** Local-midnight Date for a YYYY-MM-DD string (never UTC-parsed). */
function localDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatLocal(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 'mon'..'sun' for a YYYY-MM-DD calendar date, independent of the host TZ.
 * (roster.dayCodeForDate used to UTC-parse a bare date string and then read
 * the LOCAL weekday, which was a day early west of UTC — ROSTERTZ.1 fixed it,
 * so the two now agree. This one stays because everything else in this module
 * is already built on localDate/formatLocal.)
 */
export function weekdayCodeOf(iso) {
  const jsDay = localDate(iso).getDay()
  return WEEKDAY_CODES[jsDay === 0 ? 6 : jsDay - 1]
}

/**
 * Template-mode month mapping: the Nth <weekday> of the source month lands on
 * the Nth <weekday> of the target month (first Monday -> first Monday), so a
 * coach stays on the same template slot. Day-of-month mapping would put a
 * Monday slot's coach onto a Thursday. Returns null when the target month has
 * no Nth <weekday> (a 5th Monday that doesn't exist).
 */
export function mapNthWeekdayOfMonth(sourceIso, targetMonthStartIso) {
  const source = localDate(sourceIso)
  const nth = Math.floor((source.getDate() - 1) / 7) // 0-based occurrence
  const targetFirst = localDate(targetMonthStartIso)
  const offset = (source.getDay() - targetFirst.getDay() + 7) % 7
  const day = 1 + offset + nth * 7
  const mapped = new Date(targetFirst.getFullYear(), targetFirst.getMonth(), day)
  if (mapped.getMonth() !== targetFirst.getMonth()) return null
  return formatLocal(mapped)
}

/** A template is usable for template-mode copies unless explicitly inactive. */
function templateRunsOn(tpl, weekday) {
  if (!tpl) return false
  if (tpl.active === false) return false
  return Array.isArray(tpl.days_of_week) && tpl.days_of_week.includes(weekday)
}

/**
 * COPYLEAVE.1 — pure. Turn time_off_requests rows into
 * `(profileId, dateIso) => boolean`: is this coach on APPROVED leave that day?
 * Both ends inclusive (time_off_requests.end_date is inclusive, mig 011). Dates
 * are YYYY-MM-DD strings, so string comparison IS date comparison.
 *
 * The status is re-checked here rather than trusted from the caller's query:
 * this is the function that says "on leave", so it must not be able to say it
 * about a request nobody approved (same posture as coachConflictsForBlock in
 * schedule-overlap.js). Any leave TYPE counts: holiday, sick, unavailable.
 */
export function approvedLeaveLookup(leaveRows) {
  const byProfile = new Map()
  for (const r of leaveRows || []) {
    if (r?.status !== 'approved' || !r.profile_id || !r.start_date || !r.end_date) continue
    if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
    byProfile.get(r.profile_id).push(r)
  }
  return (profileId, dateIso) =>
    (byProfile.get(profileId) || []).some((r) => r.start_date <= dateIso && r.end_date >= dateIso)
}

/** COPYLEAVE.1 — pure. Distinct profile ids with a LIVE assignment in these blocks. */
export function liveCoachIds(sourceBlocks) {
  const ids = new Set()
  for (const b of sourceBlocks || []) {
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      if (a.profile_id) ids.add(a.profile_id)
    }
  }
  return [...ids]
}

/**
 * Pure. Turn source blocks (fetchSourceBlocks shape) into what the batch
 * writer needs.
 *
 * @param {Array<object>} sourceBlocks
 * @param {object} opts
 * @param {'exact'|'template'} opts.mode
 * @param {(sourceDate: string) => string|null} opts.mapDate  source block_date
 *   -> target date, or null when the day has no counterpart (skipped).
 * @param {(profileId: string, targetDate: string) => boolean} [opts.isOnLeave]
 *   COPYLEAVE.1 — approvedLeaveLookup(...). A live source coach on APPROVED
 *   leave on the TARGET date is not copied; they count in `skipped` and in
 *   `skippedOnLeave`. Omitted = nobody is on leave.
 * @returns {{
 *   rows: Array<object>,     // bulkUpsertShiftAssignments rows
 *   blocks: Array<object>,   // target blocks to ensure (exact mode only)
 *   skipped: number,         // live source assignments not copied
 *   skippedOnLeave: number,  // the part of skipped that was approved leave
 *   sourceAssignments: number,
 * }}
 */
export function buildCopyPlan(sourceBlocks, { mode, mapDate, isOnLeave = null }) {
  if (!COPY_MODES.includes(mode)) throw new Error(`unknown copy mode: ${mode}`)
  const onLeave = typeof isOnLeave === 'function' ? isOnLeave : () => false
  const rows = []
  const blocks = []
  let skipped = 0
  let skippedOnLeave = 0
  let sourceAssignments = 0

  for (const b of sourceBlocks || []) {
    const live = (b.shift_assignments || []).filter(isLiveAssignment)
    sourceAssignments += live.length
    const targetDate = mapDate(b.block_date)
    if (!targetDate) {
      skipped += live.length
      continue
    }

    if (mode === 'exact') {
      // An EMPTY block is only carried where its template actually runs on the
      // target weekday. Day-of-month month mapping shifts the weekday, and the
      // source month is full of cron-made empty blocks for every slot, so
      // without this a Saturday-only template's empty blocks landed on Tuesdays
      // (reading as understaffed, and joining a published roster). A staffed
      // block is a carbon copy and is carried wherever it lands.
      if (live.length > 0 || templateRunsOn(b.shift_templates, weekdayCodeOf(targetDate))) blocks.push({
        shiftTemplateId: b.template_id,
        shiftDate: targetDate,
        startTime: b.start_time ?? null,
        endTime: b.end_time ?? null,
        minCoaches: b.min_coaches ?? null,
        maxCoaches: b.max_coaches ?? null,
      })
      for (const a of live) {
        // COPYLEAVE.1 — a coach on approved leave that day is not put back on
        // it. The block above is still ensured, so the slot shows as a gap.
        if (onLeave(a.profile_id, targetDate)) { skipped++; skippedOnLeave++; continue }
        rows.push({
          profileId: a.profile_id,
          shiftTemplateId: b.template_id,
          shiftDate: targetDate,
          // The time the coach actually worked: their own override, else the
          // source block's (possibly edited) time. The writer turns this into
          // an override only where it differs from the TARGET block.
          startTime: a.start_time_override || b.start_time || null,
          endTime: a.end_time_override || b.end_time || null,
          partialReason: a.partial_reason ?? null,
          notes: a.notes ?? null,
          // Never carry swapped/cancelled forward.
          status: 'scheduled',
        })
      }
      continue
    }

    // template mode
    const tpl = b.shift_templates
    if (!templateRunsOn(tpl, weekdayCodeOf(targetDate))) {
      skipped += live.length
      continue
    }
    // The template's DEFINED times, as absolute times: the writer turns them
    // into an override only where the target block was edited away from the
    // template, so a coach lands at the template's times either way and a
    // block at template times (the normal case) carries no override at all.
    for (const a of live) {
      if (onLeave(a.profile_id, targetDate)) { skipped++; skippedOnLeave++; continue }
      rows.push({
        profileId: a.profile_id,
        shiftTemplateId: b.template_id,
        shiftDate: targetDate,
        startTime: tpl.start_time ?? null,
        endTime: tpl.end_time ?? null,
        partialReason: null,
        notes: null,
        status: 'scheduled',
      })
    }
  }

  return { rows, blocks, skipped, skippedOnLeave, sourceAssignments }
}

// ── UI copy (shared by the schedule calendar's copy dialog) ─────────────────

/** The two choices the copy dialog offers, in order. */
export const COPY_MODE_OPTIONS = [
  {
    mode: 'exact',
    label: 'Exact copy',
    description: 'Copies every shift, coach and time exactly as they were.',
  },
  {
    mode: 'template',
    label: 'From templates',
    description: "Puts the same coaches on each shift at its template times; one-off time changes aren't copied.",
  },
]

/**
 * Pure. The toast for a finished copy: `{ message, kind }`. Reports copied and
 * skipped counts; a skip is a warning because the operator may want to fill
 * those slots by hand.
 *
 * @param {object} r
 * @param {'week'|'month'} r.period
 * @param {'exact'|'template'} r.mode
 * @param {number} [r.copied]
 * @param {number} [r.skipped]          includes skippedRemoved
 * @param {number} [r.skippedRemoved]   SLOTREMOVAL.1 — skipped because the
 *   target slot was deleted by a manager
 */
export function copyResultToast({ period, mode, copied = 0, skipped = 0, skippedRemoved = 0 }) {
  const n = Number(copied) || 0
  const total = Number(skipped) || 0
  const removed = Math.min(Number(skippedRemoved) || 0, total)
  const copiedText = `Copied ${n} ${n === 1 ? 'shift' : 'shifts'}.`
  if (total === 0) {
    return { kind: 'success', message: n === 0 ? `${copiedText} Everyone was already on the target ${period}.` : copiedText }
  }
  const removedText = removed > 0
    ? `${removed} skipped because that slot was deleted in the target ${period}.`
    : ''
  const s = total - removed
  if (s === 0) return { kind: 'warning', message: `${copiedText} ${removedText}` }
  let why
  if (mode === 'template') {
    why = period === 'month'
      ? "their template is inactive, no longer runs that weekday, or the target month has no matching weekday (a 5th Monday)."
      : 'their template is inactive or no longer runs that weekday.'
  } else {
    why = 'that day of the month does not exist in the target (usually 31 Jan into Feb).'
  }
  const otherText = `${s} skipped, ${why}`
  return { kind: 'warning', message: removedText ? `${copiedText} ${removedText} ${otherText}` : `${copiedText} ${otherText}` }
}
