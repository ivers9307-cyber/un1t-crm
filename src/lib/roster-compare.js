// src/lib/roster-compare.js
// SNAPSHOT.1 — "as published" vs "as finally rostered" vs "as arrived". PURE:
// no IO, every clock and zone is an argument.
//
// THREE VIEWS OF ONE ROSTER
//   as published        roster_publish_snapshots.snapshot (mig 634), written
//                       once when the roster was published and never again.
//   as finally rostered the live shift_blocks + shift_assignments.
//   as arrived          shift_assignments.arrived_at (ARRIVAL.1, mig 609),
//                       carried onto a back-to-back shift exactly as the
//                       attendance report does (inferContinuousArrivals).
//
// MATCHING. A block is matched on its SLOT, (template_id, block_date): the
// unique key shift_blocks carries (mig 067) and the key a deleted slot is
// recorded on (mig 613). Never on its id, so a block deleted and made again for
// the same slot reads as the same shift. A coach is matched on profile_id
// within the slot (unique per block, mig 067). A swap rewrites the
// assignment's profile_id, so the giver reads "removed" and the taker "added":
// that IS the difference between who was published and who is rostered.
//
// WINDOWS. A coach's window is their override, else the BLOCK's own time,
// never the template (the mig 604/622 COALESCE; shared/roster-month.js).
// Hours are WALL-CLOCK minutes, wrapping past midnight when the end is before
// the start, which is payroll.shiftHours's rule, so these totals agree with
// every other hours figure (a shift across a DST change counts its wall-clock
// length there too). One deliberate difference: '24:00' is midnight here;
// payroll.timeToHours refuses hour 24 and counts such a shift 0h.
//
// ENDED / NO ARRIVAL are judged on real instants in the studio's zone
// (wallInstant: DST-exact, '24:00' = the next midnight; an end before the start
// ends on the next day). "Ended" is the COACH's own window (override, else the
// block). The back-to-back CARRY-OVER is the attendance report's rule to the
// letter (src/app/api/attendance/route.js): the gap between the same coach's
// shifts that day is measured on the BLOCKS' times (resolveScheduledAt),
// never an override, so the two surfaces never disagree about a carry. "No arrival recorded" is ADVISORY: arrival stamps
// exist for a minority of shifts, so it is a prompt to check, never a
// no-show, and nothing here alerts anyone.
//
// BRIEFING (BLOCKEDIT.1, mig 629) is part of what coaches were told, so each
// block records it as `briefing_hash`: the SHA-256 of the normalised text, null
// when there is none. Never the text. A row here can never be corrected or
// erased, and free text can name a person; the change log keeps the text out
// of its details for the same reason. The fingerprint is enough to say
// "briefing added / changed / removed after publish". The key is additive to
// format 1: a block without it reads as "not recorded", never as a change.
//
// NEVER PAY. Times, hours, profile ids, names and arrival stamps only.

import { createHash } from 'node:crypto'
import { isLiveAssignment, slotKey } from './roster'
import { shiftKindOf } from '@shared/shift-kind'
import { normaliseBriefing } from '@shared/shift-briefing'
import { wallInstant } from './staff-calendar-feed'
import { resolveTz } from './tz-time'
import { addDaysISO } from './dublin-time'
import { inferContinuousArrivals, arrivalToTimeOnly, resolveScheduledAt } from './staff-attendance'

export const SNAPSHOT_FORMAT_VERSION = 1

/** 'HH:MM[:SS[.f]]' -> 'HH:MM'; '24:00:00' -> '24:00'; anything else -> null. */
export function hhmm(t) {
  const m = String(t ?? '').match(/^([01]\d|2[0-4]):([0-5]\d)(?::\d{2}(?:\.\d+)?)?$/)
  if (!m) return null
  if (m[1] === '24' && m[2] !== '00') return null
  return `${m[1]}:${m[2]}`
}

function minutesOf(t) {
  const v = hhmm(t)
  if (!v) return null
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5))
}

/** Wall-clock hours of { start, end }, wrapping past midnight. 0 when unreadable. */
export function windowHours(win) {
  const s = minutesOf(win?.start)
  const e = minutesOf(win?.end)
  if (s == null || e == null) return 0
  let d = e - s
  if (d < 0) d += 24 * 60
  return d / 60
}

/** A coach's window on a block: their override, else the block's own time. */
export function effectiveWindow(assignment, block) {
  return {
    start: hhmm(assignment?.start_time_override) || hhmm(block?.start_time),
    end: hhmm(assignment?.end_time_override) || hhmm(block?.end_time),
  }
}

/** SHA-256 hex of a block's normalised briefing; null when it has none. */
export function briefingHash(briefing) {
  const text = normaliseBriefing(briefing)
  return text == null ? null : createHash('sha256').update(text, 'utf8').digest('hex')
}

// One shift_blocks row (with shift_templates(name, kind) and
// shift_assignments(...) embedded) -> the snapshot's block shape. Used for the
// published side at publish time AND for the live side at compare time, so the
// two can never be normalised differently.
export function normaliseBlock(b) {
  const coaches = (b.shift_assignments || [])
    .filter((a) => a && a.profile_id && isLiveAssignment(a))
    .map((a) => ({
      assignment_id: a.id ?? null,
      profile_id: a.profile_id,
      ...effectiveWindow(a, b),
      overridden: Boolean(a.start_time_override || a.end_time_override),
    }))
    .sort((x, y) => String(x.profile_id).localeCompare(String(y.profile_id)))
  return {
    slot: slotKey(b.template_id, b.block_date),
    block_id: b.id ?? null,
    date: String(b.block_date).slice(0, 10),
    template_id: b.template_id,
    template_name: b.shift_templates?.name ?? null,
    kind: shiftKindOf(b),
    start: hhmm(b.start_time),
    end: hhmm(b.end_time),
    min: b.min_coaches ?? null,
    max: b.max_coaches ?? null,
    briefing_hash: briefingHash(b.briefing),
    coaches,
  }
}

function snapshotBlockOrder(x, y) {
  return String(x.date).localeCompare(String(y.date))
    || String(x.start ?? '').localeCompare(String(y.start ?? ''))
    || String(x.template_name ?? '').localeCompare(String(y.template_name ?? ''))
    || String(x.slot).localeCompare(String(y.slot))
}

/**
 * The document stored in roster_publish_snapshots.snapshot.
 *
 * @param {{ periodStart: string, periodEnd: string, blocks: object[] }} args
 *   blocks: shift_blocks rows at the location, as loadWindowBlocks returns them
 * @returns {{ snapshot: object, blockCount: number, assignmentCount: number }}
 */
export function buildPublishSnapshot({ periodStart, periodEnd, blocks }) {
  const out = (blocks || [])
    .filter((b) => b && b.template_id && b.block_date)
    .filter((b) => {
      const d = String(b.block_date).slice(0, 10)
      return d >= periodStart && d <= periodEnd
    })
    .map(normaliseBlock)
    .sort(snapshotBlockOrder)
  return {
    snapshot: { v: SNAPSHOT_FORMAT_VERSION, period_start: periodStart, period_end: periodEnd, blocks: out },
    blockCount: out.length,
    assignmentCount: out.reduce((n, b) => n + b.coaches.length, 0),
  }
}

export const COMPARE_CHANGES = Object.freeze(['unchanged', 'moved', 'added', 'removed'])

/** The published period narrowed to [from, to]; null when they do not overlap. */
export function clipWindow(snapshot, from, to) {
  const lo = from && from > snapshot.period_start ? from : snapshot.period_start
  const hi = to && to < snapshot.period_end ? to : snapshot.period_end
  return lo <= hi ? { from: lo, to: hi } : null
}

function sameWindow(a, b) {
  return (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null)
}

function changeOf(was, now) {
  if (!was) return 'added'
  if (!now) return 'removed'
  return sameWindow(was, now) ? 'unchanged' : 'moved'
}

// The instant a window ends in `tz`: an end before the start is the next day's
// wall clock ('24:00' compares after every start, and wallInstant reads it as
// the next midnight).
function endInstant(date, win, tz) {
  if (!win?.start || !win?.end) return null
  const endDate = win.end < win.start ? addDaysISO(date, 1) : date
  return wallInstant(endDate, win.end, tz)
}

// null when nothing changed, when either side is missing (a block added or
// removed after publish says so itself), or when the snapshot predates the
// briefing_hash key (undefined = not recorded, never a change).
function briefingChangeOf(p, c) {
  if (!p || !c || p.briefing_hash === undefined) return null
  const was = p.briefing_hash ?? null
  const now = c.briefing_hash ?? null
  if (was === now) return null
  if (!was) return 'added'
  if (!now) return 'removed'
  return 'changed'
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function emptyTotals() {
  return {
    published_shifts: 0, published_hours: 0,
    current_shifts: 0, current_hours: 0, hours_delta: 0,
    unchanged: 0, moved: 0, added: 0, removed: 0,
    ended: 0, arrived: 0, arrived_inferred: 0, no_show_candidates: 0,
    blocks_added: 0, blocks_removed: 0, blocks_moved: 0, blocks_staffing_changed: 0,
    blocks_briefing_changed: 0,
  }
}

function coachOrder(x, y) {
  return String(x.name ?? '\uFFFF').localeCompare(String(y.name ?? '\uFFFF'))
    || String(x.profile_id).localeCompare(String(y.profile_id))
}

function compareBlockOrder(x, y) {
  const xs = (x.current || x.published)?.start ?? ''
  const ys = (y.current || y.published)?.start ?? ''
  return String(x.date).localeCompare(String(y.date))
    || String(xs).localeCompare(String(ys))
    || String(x.template_name ?? '').localeCompare(String(y.template_name ?? ''))
    || String(x.slot).localeCompare(String(y.slot))
}

/**
 * A snapshot against the live roster and its arrival stamps.
 *
 * @param {object} args
 * @param {object} args.snapshot       roster_publish_snapshots.snapshot (format 1)
 * @param {object[]} args.currentBlocks live shift_blocks rows (loadWindowBlocks shape,
 *                                      assignments embedded with arrived_at and profiles(full_name))
 * @param {string|null} [args.from]    YYYY-MM-DD; narrows the window
 * @param {string|null} [args.to]
 * @param {number} args.nowMs          what "ended" is judged against
 * @param {string|null} [args.tz]      locations.timezone; unknown -> Europe/Dublin
 * @param {Record<string,string>} [args.names]  profile_id -> full_name for coaches
 *                                      not on the live roster any more
 * @returns {{ window: {from,to}|null, blocks: object[], totals: object }}
 */
export function compareSnapshot({ snapshot, currentBlocks, from = null, to = null, nowMs = Date.now(), tz = null, names = {} }) {
  const zone = resolveTz(tz)
  const totals = emptyTotals()
  const window = snapshot ? clipWindow(snapshot, from, to) : null
  if (!window) return { window: null, blocks: [], totals }
  const inWindow = (d) => d >= window.from && d <= window.to

  const published = new Map()
  for (const b of snapshot.blocks || []) if (inWindow(b.date)) published.set(b.slot, b)

  const current = new Map()
  const arrivals = new Map() // `${slot}|${profile_id}` -> arrived_at of the LIVE assignment
  const nameOf = { ...names }
  for (const raw of currentBlocks || []) {
    if (!raw?.template_id || !raw?.block_date) continue
    const b = normaliseBlock(raw)
    if (!inWindow(b.date)) continue
    current.set(b.slot, b)
    for (const a of raw.shift_assignments || []) {
      if (!a?.profile_id) continue
      // Any embedded row names its coach, cancelled or not: a removed coach
      // still reads by name.
      if (a.profiles?.full_name && !nameOf[a.profile_id]) nameOf[a.profile_id] = a.profiles.full_name
      if (isLiveAssignment(a) && a.arrived_at) arrivals.set(`${b.slot}|${a.profile_id}`, a.arrived_at)
    }
  }

  const blocks = []
  const timed = [] // rows on the live roster, for the arrival carry-over
  for (const slot of new Set([...published.keys(), ...current.keys()])) {
    const p = published.get(slot) || null
    const c = current.get(slot) || null
    const block = {
      slot,
      date: (c || p).date,
      template_name: c?.template_name ?? p?.template_name ?? null,
      kind: (c || p).kind,
      published: p ? { start: p.start, end: p.end, min: p.min, max: p.max } : null,
      current: c ? { start: c.start, end: c.end, min: c.min, max: c.max } : null,
      change: changeOf(p, c),
      staffing_changed: Boolean(p && c && (p.min !== c.min || p.max !== c.max)),
      // 'added' | 'changed' | 'removed' | null. Never the text (see BRIEFING).
      briefing_change: briefingChangeOf(p, c),
      coaches: [],
    }
    const was = new Map((p?.coaches || []).map((x) => [x.profile_id, x]))
    const now = new Map((c?.coaches || []).map((x) => [x.profile_id, x]))
    for (const pid of new Set([...was.keys(), ...now.keys()])) {
      const w = was.get(pid) || null
      const n = now.get(pid) || null
      const row = {
        profile_id: pid,
        name: nameOf[pid] ?? null,
        published: w ? { start: w.start, end: w.end } : null,
        current: n ? { start: n.start, end: n.end } : null,
        change: changeOf(w, n),
        arrived_at: null,
        arrived_local: null,
        arrival_inferred: false,
        ended: false,
        no_show_candidate: false,
      }
      if (n) {
        const arrivedMs = Date.parse(arrivals.get(`${slot}|${pid}`) || '')
        timed.push({
          row,
          // "Ended" is the COACH's own window (override, else block).
          endMs: endInstant(c.date, n, zone),
          profileId: pid,
          blockDate: c.date,
          // Review 4 — the carry-over is measured on the BLOCK's times, as
          // the attendance report measures it (attendance/route.js), never
          // the coach's override window, so the two never disagree.
          scheduledAt: resolveScheduledAt(c.date, c.start, zone),
          scheduledEndAt: resolveScheduledAt(c.date, c.end, zone),
          arrivalAt: Number.isFinite(arrivedMs) ? arrivedMs : null,
        })
      }
      block.coaches.push(row)
    }
    block.coaches.sort(coachOrder)
    blocks.push(block)
  }

  // The attendance report's rule: a shift with no stamp inherits the same
  // coach's previous shift's arrival that day when the gap is at most an hour.
  // Returned in input order.
  inferContinuousArrivals(timed).forEach((r, i) => {
    const { row, endMs } = timed[i]
    row.ended = Number.isFinite(endMs) && endMs <= nowMs
    if (Number.isFinite(r.arrivalAt)) {
      row.arrived_at = new Date(r.arrivalAt).toISOString()
      row.arrived_local = (arrivalToTimeOnly(r.arrivalAt, zone) || '').slice(0, 5) || null
      row.arrival_inferred = Boolean(r.arrivalInferred)
    }
    row.no_show_candidate = row.ended && !row.arrived_at
  })

  blocks.sort(compareBlockOrder)

  for (const b of blocks) {
    if (b.change === 'added') totals.blocks_added += 1
    else if (b.change === 'removed') totals.blocks_removed += 1
    else if (b.change === 'moved') totals.blocks_moved += 1
    if (b.staffing_changed) totals.blocks_staffing_changed += 1
    if (b.briefing_change) totals.blocks_briefing_changed += 1
    for (const r of b.coaches) {
      totals[r.change] += 1
      if (r.published) {
        totals.published_shifts += 1
        totals.published_hours += windowHours(r.published)
      }
      if (r.current) {
        totals.current_shifts += 1
        totals.current_hours += windowHours(r.current)
      }
      if (r.ended) {
        totals.ended += 1
        if (r.arrived_at) {
          totals.arrived += 1
          if (r.arrival_inferred) totals.arrived_inferred += 1
        } else {
          totals.no_show_candidates += 1
        }
      }
    }
  }
  totals.published_hours = round2(totals.published_hours)
  totals.current_hours = round2(totals.current_hours)
  totals.hours_delta = round2(totals.current_hours - totals.published_hours)

  return { window, blocks, totals }
}
