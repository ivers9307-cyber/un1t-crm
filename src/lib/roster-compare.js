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
// ends on the next day). "No arrival recorded" is ADVISORY: arrival stamps
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
