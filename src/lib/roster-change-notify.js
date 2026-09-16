// NOTIFY.1 — tell a coach, at the moment of change, that they were added to
// or removed from a shift on a PUBLISHED roster.
//
// Before this, those edits only wrote a roster_change_log row and waited for
// the manager to re-publish that exact period from the web week view. The
// 16 Sep review found 25 of the last 30 changes never sent and 49 notices
// that went out after the shift had already happened. The re-publish path
// (renotifyChangedCoaches in roster-notify.js) stays as the safety net for
// anything this could not deliver.
//
// Category: shift_adjusted (decision D-C). It already has email fallback, an
// `updates` Android channel, a default-on permission for every role, and the
// phone deep-links data.type 'shift_adjusted' + block_date to that week.
// Time changes are NOT handled here: the assignment PUT already pushes them.

import { notifyUsers } from './notify'
import { logWarn } from './log'
import { dublinTodayStr } from './dublin-time'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NOTIFIABLE = new Set(['assigned', 'unassigned'])
// PostgREST returns at most 1,000 rows per select (CLAUDE.md).
const RANGE_CAP = 1000

/** 'YYYY-MM-DD' → 'Fri 18 Sep'. Locale-independent on purpose. */
export function formatShiftDate(isoDay) {
  const [y, m, d] = String(isoDay).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`
}

const shifts = (n) => `${n} ${n === 1 ? 'shift' : 'shifts'}`

/** Pure. One coach's changes → { title, body }. */
export function buildRosterChangeMessage(changes) {
  const added = changes.filter((c) => c.action === 'assigned').length
  const removed = changes.filter((c) => c.action === 'unassigned').length
  const dates = changes.map((c) => c.blockDate).sort()
  const first = dates[0]
  const last = dates[dates.length - 1]

  if (changes.length === 1) {
    const day = formatShiftDate(first)
    return added === 1
      ? { title: 'Added to a shift', body: `You're now on the roster for ${day}.` }
      : { title: 'Removed from a shift', body: `You're no longer on the roster for ${day}.` }
  }

  const parts = []
  if (added) parts.push(`added to ${shifts(added)}`)
  if (removed) parts.push(`removed from ${shifts(removed)}`)
  const span = first === last
    ? `on ${formatShiftDate(first)}`
    : `between ${formatShiftDate(first)} and ${formatShiftDate(last)}`
  return { title: 'Roster updated', body: `You were ${parts.join(' and ')} ${span}.` }
}

async function markNotified(db, { locationId, coachId, blockIds }) {
  if (!locationId || blockIds.length === 0) return
  const { error } = await db
    .from('roster_change_log')
    .update({ notified_at: new Date().toISOString() })
    .eq('location_id', locationId)
    .eq('coach_id', coachId)
    .in('block_id', blockIds)
    .is('notified_at', null)
  if (error) logWarn('roster-change-notify', 'mark notified failed', { coachId, err: error.message })
}

/**
 * Notify each affected coach once. Best-effort; never throws.
 *
 * A coach whose changes are ALL in the past gets no message (nobody needs
 * telling about a shift that already happened) but their rows ARE stamped —
 * leaving them unstamped would make the re-publish safety net send a late
 * "Roster updated" for something already over. A coach with a MIX of past
 * and future changes is messaged about the future ones only, and — on
 * delivery — every one of their block ids (past and future) is stamped.
 *
 * @param {object} db service-role client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string} opts.actorId      the manager making the change
 * @param {Array<{coachId: string, blockId: string, blockDate: string, action: string}>} opts.changes
 * @param {string} [opts.todayStr]   YYYY-MM-DD (Dublin); injectable for tests
 */
export async function notifyRosterChanges(db, { locationId, actorId, changes, todayStr } = {}) {
  const today = todayStr || dublinTodayStr()
  const result = { notified: 0, skippedSelf: 0, skippedPast: 0, undelivered: 0, optedOut: 0 }
  try {
    const byCoach = new Map()
    for (const c of changes || []) {
      if (!c?.coachId || !c?.blockDate || !NOTIFIABLE.has(c.action)) continue
      if (!byCoach.has(c.coachId)) byCoach.set(c.coachId, [])
      byCoach.get(c.coachId).push(c)
    }

    for (const [coachId, list] of byCoach) {
      try {
        const future = list.filter((c) => c.blockDate >= today)
        const past = list.filter((c) => c.blockDate < today)
        result.skippedPast += past.length
        const allBlockIds = [...new Set(list.map((c) => c.blockId).filter(Boolean))]

        if (future.length === 0) {
          // Nothing left to tell them about, but stamp so the re-publish
          // safety net doesn't message them about a shift already over.
          await markNotified(db, { locationId, coachId, blockIds: allBlockIds })
          continue
        }

        if (coachId === actorId) {
          // They made the change themselves; there is nobody to tell.
          result.skippedSelf++
          await markNotified(db, { locationId, coachId, blockIds: allBlockIds })
          continue
        }

        const { title, body } = buildRosterChangeMessage(future)
        const firstDate = future.map((c) => c.blockDate).sort()[0]
        const totals = await notifyUsers([coachId], {
          title,
          body,
          category: 'shift_adjusted',
          emailSubject: title,
          data: { type: 'shift_adjusted', block_date: firstDate, location_id: locationId },
        })
        const delivered = (totals?.sent || 0) + (totals?.emailed || 0) > 0
        const failed = (totals?.failed || 0) > 0
        if (delivered) {
          result.notified++
          await markNotified(db, { locationId, coachId, blockIds: allBlockIds })
        } else if (!failed && (totals?.skipped || 0) > 0) {
          // The coach turned this category off — the re-publish path would
          // otherwise message them on a different category behind their back.
          result.optedOut++
          await markNotified(db, { locationId, coachId, blockIds: allBlockIds })
        } else {
          // No token, no email, and no explicit opt-out: leave the rows for
          // the re-publish safety net.
          result.undelivered++
        }
      } catch (e) {
        // One coach's failure must not stop the rest of the batch.
        logWarn('roster-change-notify', 'notify failed for coach', { locationId, coachId, err: e?.message })
      }
    }
  } catch (e) {
    logWarn('roster-change-notify', 'notify failed', { locationId, err: e?.message })
  }
  return result
}

/** Coach/block pairs in a date range, with each block's roster status. */
export async function readAssignmentKeysInRange(db, { locationId, startDate, endDate }) {
  const { data, error } = await db
    .from('shift_assignments')
    .select('block_id, profile_id, shift_blocks!inner(location_id, block_date, rosters:roster_id(status))')
    .eq('shift_blocks.location_id', locationId)
    .gte('shift_blocks.block_date', startDate)
    .lte('shift_blocks.block_date', endDate)
    .order('block_id')
  if (error) return { rows: null, error, truncated: false }
  const rows = data || []
  return { rows, error: null, truncated: rows.length >= RANGE_CAP }
}

/** Pure. Pairs present after but not before, on a published block. */
export function publishedAdditions(beforeRows, afterRows) {
  const key = (r) => `${r.block_id}|${r.profile_id}`
  const before = new Set((beforeRows || []).map(key))
  return (afterRows || [])
    .filter((r) => !before.has(key(r)) && r.shift_blocks?.rosters?.status === 'published')
    .map((r) => ({ coachId: r.profile_id, blockId: r.block_id, blockDate: r.shift_blocks.block_date, action: 'assigned' }))
}

/**
 * Copy-week / copy-month: log and notify coaches the copy put on blocks that
 * are already published. `before` is readAssignmentKeysInRange taken before
 * the copy. Fails open (logs and skips) so a copy never fails on notification.
 */
export async function logAndNotifyCopiedShifts(db, { locationId, actorId, startDate, endDate, before, via, todayStr }) {
  try {
    if (!before || before.error || before.truncated) {
      logWarn('roster-change-notify', 'copy notify skipped: target range unreadable before the copy', { locationId, startDate, endDate, via })
      return { logged: 0, notify: null }
    }
    const after = await readAssignmentKeysInRange(db, { locationId, startDate, endDate })
    if (after.error || after.truncated) {
      logWarn('roster-change-notify', 'copy notify skipped: target range unreadable after the copy', { locationId, startDate, endDate, via })
      return { logged: 0, notify: null }
    }
    const adds = publishedAdditions(before.rows, after.rows)
    let logged = 0
    if (adds.length > 0) {
      const rows = adds.map((add) => ({
        location_id: locationId,
        block_id: add.blockId,
        block_date: add.blockDate,
        actor_id: actorId,
        coach_id: add.coachId,
        action: 'assigned',
        details: { via },
      }))
      const { error: insertError } = await db.from('roster_change_log').insert(rows)
      if (insertError) {
        // The re-publish safety net relies on these rows existing, but
        // losing the message entirely is worse than losing the audit
        // trail — still notify below.
        logWarn('roster-change-notify', 'copy change-log insert failed', { locationId, via, err: insertError.message })
      } else {
        logged = rows.length
      }
    }
    const notify = await notifyRosterChanges(db, { locationId, actorId, changes: adds, ...(todayStr ? { todayStr } : {}) })
    return { logged, notify }
  } catch (e) {
    logWarn('roster-change-notify', 'copy notify failed', { locationId, via, err: e?.message })
    return { logged: 0, notify: null }
  }
}
