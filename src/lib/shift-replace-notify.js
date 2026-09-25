// src/lib/shift-replace-notify.js
//
// REPLACE.1a — the */5 arm that sends replace notices the route could not:
// those made outside 07:00-22:00 studio time (quiet hours gate the NOTICE,
// never the replace), and any whose after() died. It rides
// /api/cron/send-push-reminders beside the shift-reminder arm.
//
// It reads roster_change_log rows with details.via = 'replace' that are still
// unstamped, younger than REPLACE_NOTICE_MAX_AGE_MS (older ones belong to the
// re-publish safety net), for a shift today or later. A coach's pile on one
// shift whose NEWEST row is younger than REPLACE_NOTICE_ROUTE_OWNS_MS is left
// alone this tick: in band the route's own after() is sending it, and out of
// band the manager is still changing it (A -> B, then B -> C a minute later
// must not tell B "added" now and "removed" five minutes on).
//
// netReplaceChanges nets each coach's rows per shift. A replace undone before
// its notice could have gone out nets to nothing: those rows are stamped with
// no message and marked details.reason = REPLACE_UNDONE_REASON, so the drawer
// never prints a "told" time for them (roster-change-format.js, writer 8).
// "Could have gone out" (review 1): a row made in band was sent by the
// route's after(), and one around since an in-band tick may have been sent by
// the arm; if its stamp then failed it is still unstamped here, so its pile is
// NOT silent and tells its last action (bandSeenBetween). A duplicate at
// worst; never B told "added" and not "removed".
//
// Everything else goes through notifyRosterChanges (NOTIFY.1's message and
// send path) with markNotified: false, and THIS arm stamps exactly its own
// rows by id after a delivery (or a self / past outcome). So a lost stamp is
// counted (stamp_failed, which keeps the heartbeat from stamping) rather than
// swallowed, and the arm never stamps another writer's rows for the same
// coach and shift. A stamp lost, or a crash between send and stamp, means the
// coach is told again next tick: a duplicate, never a loss. An opted-out or
// unreachable coach is left unstamped for the re-publish safety net; this arm
// retries them every tick until the rows age out (a send nobody receives).
//
// Never throws on a read or a send. Returns counts for the cron's response;
// `errors` (the held-row read, a silent stamp) and `stamp_failed` are faults
// in the arm's own machinery (cron-arm-health.js replaceNoticeArmHealthy).
// `send_failed` is a delivery failure, retried next tick, and not a fault
// (the THE RULE of cron-arm-health.js).

import { notifyRosterChanges } from './roster-change-notify'
import { inStaffPushHours } from './staff-push-hours'
import { dublinTodayStr } from './dublin-time'
import { logError, logWarn } from './log'
import {
  netReplaceChanges, bandSeenBetween, REPLACE_VIA, REPLACE_UNDONE_REASON, REPLACE_NOTICE_ROUTE_OWNS_MS, REPLACE_NOTICE_MAX_AGE_MS,
} from './shift-replace'

// Literal: check:select-columns resolves only literal selects.
const HELD_SELECT = 'id, location_id, block_id, block_date, actor_id, coach_id, action, created_at, shift_blocks!block_id(start_time)'
// Replaces are a handful a night. A guard, not a page size: past it the
// oldest are sent and the rest wait a tick.
const HELD_LIMIT = 500

const iso = (ms) => new Date(ms).toISOString()
const pileKey = (r) => `${r.location_id}|${r.coach_id}|${r.block_id}`

export async function runReplaceNotices(db, { nowMs = Date.now(), todayStr = dublinTodayStr() } = {}) {
  const stats = { rows: 0, groups: 0, told: 0, silent: 0, quiet: 0, fresh: 0, undelivered: 0, send_failed: 0, stamp_failed: 0, errors: 0 }
  let rows
  try {
    const { data, error } = await db.from('roster_change_log')
      .select(HELD_SELECT)
      .is('notified_at', null)
      .eq('details->>via', REPLACE_VIA)
      .gte('created_at', iso(nowMs - REPLACE_NOTICE_MAX_AGE_MS))
      .gte('block_date', todayStr)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(HELD_LIMIT)
    if (error) throw new Error(error.message)
    rows = data || []
  } catch (e) {
    logError('shift-replace-notify', 'could not read held replace notices; the next tick retries', { err: e?.message })
    stats.errors++
    return stats
  }
  stats.rows = rows.length
  if (!rows.length) return stats

  // A pile the route still owns (or the manager is still changing) waits.
  const ownedSince = nowMs - REPLACE_NOTICE_ROUTE_OWNS_MS
  const freshPiles = new Set(rows.filter((r) => Date.parse(r.created_at) > ownedSince).map(pileKey))
  stats.fresh = freshPiles.size
  const settled = rows.filter((r) => !freshPiles.has(pileKey(r)))
  if (!settled.length) return stats

  const tzById = new Map()
  try {
    const ids = [...new Set(settled.map((r) => r.location_id).filter(Boolean))]
    const { data, error } = await db.from('locations').select('id, timezone').in('id', ids)
    if (error) throw new Error(error.message)
    for (const l of data || []) tzById.set(l.id, l.timezone)
  } catch (e) {
    logWarn('shift-replace-notify', 'studio timezones unreadable; using Europe/Dublin', { err: e?.message })
  }

  const tzOf = (locationId) => tzById.get(locationId) ?? null
  // Review 1 — a row that may already have been told (made in band, or
  // around since an in-band tick) keeps its pile out of the silent path.
  const mayHaveBeenTold = (r) => bandSeenBetween(Date.parse(r.created_at), nowMs, tzOf(r.location_id))
  const { send, silent } = netReplaceChanges(settled, { mayHaveBeenTold })
  if (silent.length) {
    const rowIds = silent.flatMap((s) => s.rowIds)
    try {
      const { data, error } = await db.from('roster_change_log')
        .update({ notified_at: iso(nowMs), details: { via: REPLACE_VIA, reason: REPLACE_UNDONE_REASON } })
        .in('id', rowIds)
        .is('notified_at', null)
        .select('id')
      if (error) throw new Error(error.message)
      stats.silent += silent.length
      if ((data || []).length < rowIds.length) {
        // Someone stamped a row meanwhile (a re-publish, an ordinary assign):
        // it is theirs now, nothing is owed.
        logWarn('shift-replace-notify', 'some undone replace rows were already stamped', { expected: rowIds.length, stamped: (data || []).length })
      }
    } catch (e) {
      stats.errors++
      logError('shift-replace-notify', 'could not stamp undone replace rows; the next tick retries', { rows: rowIds.length, err: e?.message })
    }
  }

  const groups = new Map()
  for (const s of send) {
    if (!inStaffPushHours(nowMs, tzOf(s.locationId))) { stats.quiet++; continue }
    const key = `${s.locationId}|${s.actorId ?? ''}`
    if (!groups.has(key)) groups.set(key, { locationId: s.locationId, actorId: s.actorId, changes: [], rowIdsByCoach: new Map() })
    const g = groups.get(key)
    g.changes.push({ coachId: s.coachId, blockId: s.blockId, blockDate: s.blockDate, startTime: s.startTime, action: s.action })
    g.rowIdsByCoach.set(s.coachId, [...(g.rowIdsByCoach.get(s.coachId) || []), ...s.rowIds])
  }
  for (const g of groups.values()) {
    // notifyRosterChanges never throws (it catches per coach). It stamps
    // nothing here (markNotified: false): the arm stamps exactly its OWN rows
    // below, so it can count a lost stamp and never stamps another writer's.
    const res = await notifyRosterChanges(db, {
      locationId: g.locationId, actorId: g.actorId, changes: g.changes, todayStr, markNotified: false,
    })
    stats.groups++
    for (const [coachId, rowIds] of g.rowIdsByCoach) {
      const outcome = res?.byCoach?.[coachId]
      if (outcome === 'delivered' || outcome === 'self' || outcome === 'past') {
        if (outcome === 'delivered') stats.told++
        await stampTold(db, { rowIds, nowMs, stats, coachId })
      } else if (outcome === 'failed') {
        stats.send_failed++ // nothing stamped: the next tick retries
      } else {
        stats.undelivered++ // opted out or unreachable: left for the re-publish safety net
      }
    }
  }
  return stats
}

// Review 1 — the post-delivery stamp, by row id. A failure is COUNTED
// (stamp_failed keeps the arm's heartbeat from stamping) and logged: those
// rows are told again next tick, a duplicate and never a loss. Zero rows
// matched means another writer stamped them meanwhile: nothing is owed.
async function stampTold(db, { rowIds, nowMs, stats, coachId }) {
  const { error } = await db.from('roster_change_log')
    .update({ notified_at: iso(nowMs) })
    .in('id', rowIds)
    .is('notified_at', null)
    .select('id')
  if (error) {
    stats.stamp_failed++
    logError('shift-replace-notify', 'replace notice delivered but not stamped; the coach will be told again next tick', {
      coachId, rowIds, err: error.message,
    })
  }
}
