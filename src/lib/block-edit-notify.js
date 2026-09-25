// src/lib/block-edit-notify.js
// BLOCKEDIT.1 — telling coaches that a PUBLISHED shift's time moved.
//
// THE RULE
//   - PUT /api/schedule/blocks/[id] writes one roster_change_log
//     'time_changed' row per coach whose OWN window moved (details
//     { source: 'block_edit', from, to }) and sends NOTHING itself.
//   - This arm, on every tick of the */5 send-push-reminders cron, tells
//     them. The notice is gated by staff QUIET HOURS (staff-push-hours.js:
//     07:00-22:00 at the studio); the STATE (the block's new time) was saved
//     the moment the manager pressed Save. Quiet hours gate the notice, never
//     the state, and a gate needs a later tick: this is that tick.
//   - ONE message per coach per shift however many edits piled up: the
//     OLDEST unsent row's `from` against the coach's window NOW (read live).
//     Net no change (edited and put back) = no message.
//   - Not sent, stamped with details.notice = 'not_needed' (the drawer then
//     shows no told time): the coach is no longer on the shift, the shift was
//     deleted, the net change is nothing, or it has already started today.
//   - Stamped only on DELIVERY (push or email fallback). Opted out, no
//     device, or a failed send: left UNSTAMPED for the re-publish safety net
//     (renotifyChangedCoaches); the per-row claim key stops this arm
//     re-sending on every tick, and a failed send releases its claim so the
//     next tick retries. Rows older than 48 hours are left to that net.
//
// Category shift_adjusted (NOTIFY.1 D-C): registered, email fallback,
// default-on for every role; the phone deep-links data.type 'shift_adjusted'
// + block_date to that week.

import { notifyUsersOnce } from './push-dedup'
import { markChangesNotified } from './roster-change-log'
import { formatShiftDate } from './roster-change-notify'
import { formatTimeRange12h } from './schedule-overlap'
import { inStaffPushHours, staffWallClockHHMM } from './staff-push-hours'
import { isLiveAssignment } from './roster'
import { toHms, sameWindow } from './block-edit'
import { dublinDayStr } from './dublin-time'
import { logWarn, logError } from './log'

export const TIME_CHANGE_SOURCE = 'block_edit'
export const TIME_CHANGE_WINDOW_MS = 48 * 60 * 60 * 1000
// PostgREST returns at most 1,000 rows per select (CLAUDE.md). A backlog that
// size means something upstream is broken; it is reported, and the rest is
// read on the next tick once these are stamped.
const PAGE = 1000

export function emptyTimeChangeSummary() {
  return {
    time_change_quiet: 0, time_change_rows: 0, time_change_told: 0, time_change_not_needed: 0,
    time_change_deduped: 0, time_change_undelivered: 0, time_change_send_failed: 0,
    time_change_stamp_failed: 0, time_change_read_failed: 0, time_change_read_capped: 0,
  }
}

/** Pure. The push / fallback-email copy. */
export function timeChangeMessage({ templateName, blockDate, from, to }) {
  const name = templateName || 'Your shift'
  return {
    title: 'Shift time changed',
    body: `${name} on ${formatShiftDate(blockDate)} is now ${formatTimeRange12h(to.start_time, to.end_time)} (was ${formatTimeRange12h(from.start_time, from.end_time)}).`,
  }
}

const byAge = (a, b) => (a.created_at === b.created_at
  ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  : (a.created_at < b.created_at ? -1 : 1))

/**
 * Pure. Unsent block-edit rows → what to send and what to stamp silently.
 * @param {Array<object>} rows  roster_change_log rows with the shift_blocks embed
 * @param {{ todayStr: string, nowHHMMByLocation: Record<string,string> }} opts
 */
export function planTimeChangeNotices(rows, { todayStr, nowHHMMByLocation = {} } = {}) {
  const groups = new Map()
  for (const r of rows || []) {
    const key = `${r.coach_id}|${r.block_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const send = []
  const silent = []
  for (const list of groups.values()) {
    list.sort(byAge)
    const oldest = list[0]
    const newest = list[list.length - 1]
    const block = oldest.shift_blocks
    const mine = (block?.shift_assignments || [])
      .find((a) => a.profile_id === oldest.coach_id && isLiveAssignment(a))
    const from = oldest.details?.from
    if (!oldest.block_id || !block || !mine || !toHms(from?.start_time) || !toHms(from?.end_time)) {
      silent.push(...list)
      continue
    }
    const now = {
      start_time: toHms(mine.start_time_override || block.start_time),
      end_time: toHms(mine.end_time_override || block.end_time),
    }
    const nowHHMM = nowHHMMByLocation[oldest.location_id]
    const started = oldest.block_date === todayStr && Boolean(nowHHMM) && now.start_time.slice(0, 5) <= nowHHMM
    if (sameWindow(from, now) || started || oldest.block_date < todayStr) {
      silent.push(...list)
      continue
    }
    send.push({
      key: `shift_time_changed:${newest.id}`,
      coachId: oldest.coach_id,
      locationId: oldest.location_id,
      blockDate: oldest.block_date,
      templateName: block.shift_templates?.name || null,
      from: { start_time: toHms(from.start_time), end_time: toHms(from.end_time) },
      to: now,
      rowIds: list.map((r) => r.id),
    })
  }
  return { send, silent }
}

/**
 * The cron arm. Never throws for a read or a send; returns counters for the
 * cron's summary (a thrown error is caught by the cron and reported too).
 *
 * @param {object} db  service-role client
 * @param {{ nowMs?: number, locations?: Array<{id: string, timezone?: string|null}> }} opts
 */
export async function runShiftTimeChangeNotices(db, { nowMs = Date.now(), locations = [] } = {}) {
  const summary = emptyTimeChangeSummary()
  const inBand = (locations || []).filter((l) => l?.id && inStaffPushHours(nowMs, l.timezone))
  if (inBand.length === 0) {
    summary.time_change_quiet = 1
    return summary
  }
  const todayStr = dublinDayStr(nowMs)
  const nowHHMMByLocation = Object.fromEntries(inBand.map((l) => [l.id, staffWallClockHHMM(nowMs, l.timezone)]))

  const { data, error } = await db
    .from('roster_change_log')
    // Literal on purpose: check:select-columns only resolves literal selects.
    .select(`
      id, location_id, block_id, block_date, coach_id, details, created_at,
      shift_blocks!block_id (
        start_time, end_time,
        shift_templates ( name ),
        shift_assignments ( profile_id, status, start_time_override, end_time_override )
      )
    `)
    .in('location_id', inBand.map((l) => l.id))
    .eq('action', 'time_changed')
    .eq('details->>source', TIME_CHANGE_SOURCE)
    .is('notified_at', null)
    .gte('block_date', todayStr)
    .gte('created_at', new Date(nowMs - TIME_CHANGE_WINDOW_MS).toISOString())
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (error) {
    summary.time_change_read_failed = 1
    logError('block-edit-notify', 'time-change read failed', { err: error.message })
    return summary
  }
  const rows = data || []
  summary.time_change_rows = rows.length
  if (rows.length >= PAGE) {
    summary.time_change_read_capped = 1
    logWarn('block-edit-notify', 'time-change read hit the 1,000-row page; the rest waits for the next tick', {})
  }

  const { send, silent } = planTimeChangeNotices(rows, { todayStr, nowHHMMByLocation })

  const stampedAt = new Date(nowMs).toISOString()
  for (const r of silent) {
    const { data: done, error: stampErr } = await db
      .from('roster_change_log')
      .update({ notified_at: stampedAt, details: { ...(r.details || {}), notice: 'not_needed' } })
      .eq('id', r.id)
      .is('notified_at', null)
      .select('id')
    if (stampErr) {
      summary.time_change_stamp_failed++
      logWarn('block-edit-notify', 'not-needed stamp failed', { rowId: r.id, err: stampErr.message })
    } else if ((done || []).length > 0) {
      summary.time_change_not_needed++
    }
  }

  for (const n of send) {
    try {
      const { title, body } = timeChangeMessage(n)
      const result = await notifyUsersOnce(db, n.key, [n.coachId], {
        title,
        body,
        category: 'shift_adjusted',
        emailSubject: title,
        data: { type: 'shift_adjusted', block_date: n.blockDate, location_id: n.locationId },
      })
      const delivered = (result?.sent || 0) + (result?.emailed || 0) > 0
      if (delivered) {
        summary.time_change_told++
        await markChangesNotified(db, n.rowIds)
      } else if ((result?.deduped || 0) > 0) {
        summary.time_change_deduped++
      } else if ((result?.failed || 0) > 0) {
        summary.time_change_send_failed++
      } else {
        summary.time_change_undelivered++
      }
    } catch (e) {
      summary.time_change_send_failed++
      logWarn('block-edit-notify', 'time-change notice failed for coach', { coachId: n.coachId, err: e?.message })
    }
  }
  return summary
}
