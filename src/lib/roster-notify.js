// Roster v2 — staff notification fan-out used after a roster
// goes published, regardless of which path got it there:
//
//   - Manager publishes under budget    → /api/schedule/rosters
//                                          (which calls the legacy
//                                          /shifts/publish for notify)
//   - Owner self-publishes over budget   → same as above
//   - Owner approves a draft (manager
//     publish over budget)              → /api/schedule/rosters/[id]/approve
//                                          calls notifyStaffOfPublish() directly
//
// Originally the notification logic lived inline in
// /api/schedule/shifts/publish; extracted here so the
// approval path can reuse it without server-to-server fetch
// gymnastics or double-flipping shifts.published.

import { logWarn } from './log'
import { isLiveAssignment } from './roster'
import { notifyUsers } from './notify'
import { collectUnnotifiedChanges, markChangesNotified } from './roster-change-log'
import { todayStrIn, getLocationZone } from './location-time'
import { formatTimeRange12h } from './schedule-overlap'
// NOTIFY.1 review — shares the 'Fri 18 Sep' date formatting with the
// moment-of-change messages. One-way import: roster-change-notify.js does
// NOT import this module, so there is no cycle.
import { formatShiftDate } from './roster-change-notify'

/**
 * RETIRE-SHIFTS-MIRROR.6 — build the notify-list for a publish from the
 * Roster v2 model instead of the (now-dropped) public.shifts flip.
 *
 * The publish paths used to capture "which shifts flipped published
 * false→true" to know who to notify. The new-model equivalent of "newly
 * published" is: assignments on the blocks that were just attached to a
 * roster (i.e. had roster_id IS NULL immediately before publish). Callers
 * capture those block ids BEFORE tagging, then pass them here.
 *
 * Returns rows shaped for notifyStaffOfPublish: { id, profile_id,
 * location_id, shift_date }. `id` is the assignment id (it becomes
 * schedule_notifications.shift_id — no longer FK-constrained to shifts).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string[]} blockIds  blocks newly attached to the roster
 * @returns {Promise<object[]>}
 */
export async function publishNotifyRowsForBlocks(db, blockIds) {
  if (!blockIds || blockIds.length === 0) return []
  const { data, error } = await db
    .from('shift_assignments')
    .select('id, profile_id, status, shift_blocks!block_id(location_id, block_date)')
    .in('block_id', blockIds)
  if (error) {
    logWarn('roster-notify', 'publishNotifyRowsForBlocks query failed', { err: error })
    return []
  }
  return (data || [])
    // ROSTER-FIX.1 — a coach whose assignment was cancelled is off the
    // roster; publishing it must not tell them they are working.
    .filter((a) => a.shift_blocks && isLiveAssignment(a))
    .map((a) => ({
      id: a.id,
      profile_id: a.profile_id,
      location_id: a.shift_blocks.location_id,
      shift_date: a.shift_blocks.block_date,
    }))
}

/**
 * Tell every coach whose shifts were just published, and record what actually
 * happened.
 *
 * PUBNOTIFY.1 — this used to be a bare `sendPush` whose schedule_notifications
 * row claimed `channel: 'email'` and never touched `delivered`. Two problems,
 * one of them silent: a coach without the app got NOTHING (the first publish is
 * the one notice that tells them the week exists), and the record of the send
 * described a channel that was never used, so nobody auditing the table could
 * see it. It now goes through `notifyUsers` — the same push-with-email-fallback
 * helper the moment-of-change notices use (NOTIFY.1,
 * src/lib/roster-change-notify.js) — and writes the channel(s) that really
 * carried it plus whether anything landed.
 *
 * Category stays `schedule` (NOT `shift_adjusted`): this is the weekly "your
 * roster is up" notice, it is the category the re-publish safety net
 * (renotifyChangedCoaches) also sends under, and it is the toggle a coach
 * reaches for when they mean "don't tell me about rosters". A coach who turned
 * `schedule` off is left alone — notifyUsers honours the opt-out for the email
 * fallback too, so nothing here goes around their back; their row records
 * channel 'none' with `delivered: false` and the reason, rather than a lie.
 *
 * Per coach rather than one batched call, like notifyRosterChanges: the whole
 * point is to know which channel reached WHICH coach, and a batched total
 * cannot say. One coach's failure never stops the rest.
 *
 * Best-effort. Failures are logged, not thrown — we never want notification
 * trouble to roll back a publish that already succeeded at the data layer.
 *
 * @param {SupabaseClient} db
 * @param {object[]} shifts  Rows just flipped to published, with
 *                           at least { id, profile_id, location_id,
 *                           shift_date }.
 * @param {object} range     { startDate, endDate, locationId, changeSummaries? }
 *   PUBSUMMARY.1 — `changeSummaries` (planChangeSummaries' `byCoach`): a coach
 *   who also has changes to shifts they already had gets them in THIS message,
 *   so a publish that covers new and changed weeks is still one message each.
 * @returns {Promise<{ notified: number, delivered: number, coachIds: string[], lostCoachIds: string[] }>}
 *   `notified` is coaches TARGETED (unchanged meaning); `delivered` is how
 *   many of them a push or an email actually reached; `coachIds` everyone
 *   messaged; `lostCoachIds` the coaches a failed read inside notifyUsers may
 *   have left untold (renotifyChangedCoaches keeps their change rows).
 */
export async function notifyStaffOfPublish(db, shifts, { startDate, endDate, locationId, changeSummaries = null }) {
  if (!shifts || shifts.length === 0) return { notified: 0, delivered: 0, coachIds: [], lostCoachIds: [] }

  const profileShifts = {}
  for (const s of shifts) {
    if (!profileShifts[s.profile_id]) profileShifts[s.profile_id] = []
    profileShifts[s.profile_id].push(s)
  }

  const rangeLabel = startDate === endDate ? startDate : `${startDate} – ${endDate}`
  const title = 'New schedule published'
  const body = `Your shifts for ${rangeLabel} are live. Tap to view.`

  const notifications = []
  const lostCoachIds = []
  let delivered = 0

  for (const [profileId, pShifts] of Object.entries(profileShifts)) {
    const changes = changeSummaries?.get?.(profileId) || []
    const changeCount = changes.length
    let totals = null
    try {
      totals = await notifyUsers([profileId], {
        title,
        body: changeCount
          ? `Your shifts for ${rangeLabel} are live, with ${changeCount === 1 ? '1 change' : `${changeCount} changes`} to shifts you already had. Tap to view.`
          : body,
        ...(changeCount ? { emailLines: changes.map(changeSummaryLine) } : {}),
        category: 'schedule',
        emailSubject: title,
        data: {
          type: 'schedule_published',
          start_date: startDate,
          end_date: endDate,
          location_id: locationId,
        },
      })
    } catch (err) {
      // notifyUsers is documented never to throw; if it ever does, one coach's
      // failure must not cost the rest of the roster their notification, and
      // the row below still gets written (as an undelivered one).
      logWarn('roster-notify', 'publish notify threw', { profileId, err: err?.message })
    }

    const sent = totals?.sent || 0
    const emailed = totals?.emailed || 0
    const reached = sent + emailed > 0
    if (reached) delivered++
    if (changeCount && (!totals || readLostSomeone(totals))) lostCoachIds.push(profileId)

    notifications.push({
      profile_id: profileId,
      shift_id: pShifts[0].id,
      type: 'roster_published',
      channel: deliveryChannel(sent, emailed),
      delivered: reached,
      metadata: {
        week_start: startDate,
        week_end: endDate,
        shift_count: pShifts.length,
        // The raw counts, so an auditor can tell "nobody was listening"
        // (opted out / no device) apart from "we tried and it broke".
        push_sent: sent,
        emails_sent: emailed,
        push_failed: totals?.failed || 0,
        email_failed: totals?.email_failed || 0,
        // push.js counts a master-switch or notify_schedule opt-out as
        // `skipped`; with nothing sent that IS the opt-out, and the coach is
        // deliberately left to the re-publish safety net rather than emailed
        // around.
        opted_out: !reached && (totals?.skipped || 0) > 0,
      },
    })
  }

  // ROSTER-FIX.8f — a PostgREST failure RESOLVES with an `error` property, it
  // does not throw, so this used to sit inside a try/catch that could never
  // fire and a failed insert was silent. Mig 603 gives
  // schedule_notifications.shift_id a real FK to shift_assignments, which makes
  // a 23503 genuinely reachable here: the representative assignment can be
  // deleted (D4's approved swap-drop) between the notify-list read and this
  // insert. Still best-effort — the message above is the notification, this row
  // is only the record that it was sent, so it is written AFTER the send and a
  // lost record never costs a coach their message.
  const { error: insertError } = await db.from('schedule_notifications').insert(notifications)
  if (insertError) {
    logWarn('roster-notify', 'notification log insert failed', { err: insertError.message })
  }

  return { notified: notifications.length, delivered, coachIds: Object.keys(profileShifts), lostCoachIds }
}

// C16 PUSHREADERR.1 — a read inside notifyUsers failed AND somebody was left
// untold by it (counted in `failed` / `email_failed`). A read that failed with
// nobody lost (everyone was allowed by default anyway, or emailed) is not a loss.
function readLostSomeone(totals) {
  return Boolean(totals?.read_failed) && ((totals.failed || 0) + (totals.email_failed || 0) > 0)
}

/**
 * PUBNOTIFY.1 — the value written to schedule_notifications.channel. The column
 * is free text (mig 010 documents "email, whatsapp" and nothing enforces it),
 * so it has to describe what this send did: both channels can carry the same
 * notice when a coach has one stale device and no others, and 'none' is a real
 * outcome (opted out, or no token and no address) that must not be dressed up
 * as a channel.
 */
export function deliveryChannel(pushSent, emailsSent) {
  if (pushSent > 0 && emailsSent > 0) return 'push+email'
  if (pushSent > 0) return 'push'
  if (emailsSent > 0) return 'email'
  return 'none'
}

// ── PUBSUMMARY.1 — one summary per coach at Publish ─────────────────────────
//
// Changes to a published roster are held until the manager publishes (only a
// shift within 24 hours is told at the moment of change: roster-notice-window.js).
// Publish then tells each coach about all of theirs in ONE message, netted
// against what the roster says now: added then removed is nothing; a coach
// removed and put back is nothing unless their times changed too.

const SUMMARY_BLOCK_CHUNK = 200
const PUSH_LINES = 2

/**
 * Pure. One coach's held change rows (oldest first) → what changed for them,
 * per shift, against the live blocks. `blocks` is a Map of block id → block
 * (with `shift_assignments` and `shift_templates`), or null when it could not
 * be read: each shift then reads as its last change, without times or name.
 * A row whose block is gone (deleted, or block_id null) can only be a removal.
 *
 * @returns {Array<{ kind: 'added'|'removed'|'changed', blockDate: string, name: string|null, startTime: string|null, endTime: string|null }>}
 *   ordered by date then start.
 */
export function summariseCoachChanges(rows, blocks, coachId) {
  const piles = new Map()
  for (const r of rows || []) {
    const key = r.block_id || `row:${r.id}`
    if (!piles.has(key)) piles.set(key, [])
    piles.get(key).push(r)
  }
  const items = []
  for (const pile of piles.values()) {
    const first = pile[0]
    const last = pile[pile.length - 1]
    const wasOn = first.action !== 'assigned'
    const timesChanged = pile.some((r) => r.action === 'time_changed')
    const block = first.block_id && blocks ? blocks.get(first.block_id) : null
    const base = { blockDate: first.block_date, name: block?.shift_templates?.name || null, startTime: null, endTime: null }
    if (blocks === null) {
      const kind = last.action === 'assigned' ? 'added' : last.action === 'unassigned' ? 'removed' : 'changed'
      items.push({ ...base, kind })
      continue
    }
    const mine = (block?.shift_assignments || []).find((a) => a.profile_id === coachId && isLiveAssignment(a))
    if (mine) {
      const window = {
        startTime: mine.start_time_override || block.start_time || null,
        endTime: mine.end_time_override || block.end_time || null,
      }
      if (!wasOn) items.push({ ...base, ...window, kind: 'added' })
      else if (timesChanged) items.push({ ...base, ...window, kind: 'changed' })
    } else if (wasOn) {
      items.push({ ...base, startTime: block?.start_time || null, endTime: block?.end_time || null, kind: 'removed' })
    }
  }
  return items.sort((x, y) => (x.blockDate === y.blockDate
    ? String(x.startTime || '').localeCompare(String(y.startTime || ''))
    : (x.blockDate < y.blockDate ? -1 : 1)))
}

/** Pure. 'Added: Tue 5 Nov, Open Gym 6–9am'. */
export function changeSummaryLine(item) {
  const verb = item.kind === 'added' ? 'Added' : item.kind === 'removed' ? 'Removed' : 'New times'
  const times = item.startTime && item.endTime ? formatTimeRange12h(item.startTime, item.endTime) : ''
  const shift = [item.name, times && (item.kind === 'changed' ? `now ${times}` : times)].filter(Boolean).join(' ')
  return `${verb}: ${formatShiftDate(item.blockDate)}${shift ? `, ${shift}` : ''}`
}

/**
 * Pure. A coach's summary → the push and the email. The push body names the
 * first PUSH_LINES changes; the email (emailLines) lists every one.
 */
export function buildChangeSummaryMessage(items) {
  const lines = items.map(changeSummaryLine)
  const title = 'Roster updated'
  if (lines.length === 1) return { title, body: `${lines[0]}.`, emailLines: lines }
  const more = lines.length - PUSH_LINES
  const shown = lines.slice(0, PUSH_LINES).join('; ')
  return {
    title,
    body: `${lines.length} changes to your shifts. ${shown}${more > 0 ? `; and ${more} more` : ''}. Tap to view.`,
    emailLines: lines,
  }
}

// The blocks the collected rows name, with their live coaches. null when the
// read failed (summariseCoachChanges then falls back to each last change).
async function readSummaryBlocks(db, blockIds) {
  const blocks = new Map()
  try {
    for (let i = 0; i < blockIds.length; i += SUMMARY_BLOCK_CHUNK) {
      const { data, error } = await db
        .from('shift_blocks')
        .select('id, block_date, start_time, end_time, shift_templates(name), shift_assignments(profile_id, status, start_time_override, end_time_override)')
        .in('id', blockIds.slice(i, i + SUMMARY_BLOCK_CHUNK))
      if (error) throw new Error(error.message)
      for (const b of data || []) blocks.set(b.id, b)
    }
    return blocks
  } catch (e) {
    logWarn('roster-notify', 'change summary could not read the shifts; each change reads as its last action', { err: e?.message })
    return null
  }
}

/**
 * PUBSUMMARY.1 — what the next Publish owes each coach: every unnotified
 * change in the period (`rows`, all of which the publish stamps) and, per
 * coach, the netted changes still worth telling (`byCoach`). A change dated
 * before today is stamped and never told. null when the studio's day cannot
 * be read: nothing is sent or stamped, and the next publish tries again.
 *
 * @returns {Promise<{ rows: object[], byCoach: Map<string, object[]> } | null>}
 */
export async function planChangeSummaries(db, { locationId, periodStart, periodEnd, todayStr }) {
  try {
    const today = todayStr || todayStrIn(await getLocationZone(db, locationId))
    const rows = await collectUnnotifiedChanges(db, { locationId, periodStart, periodEnd })
    const future = rows.filter((r) => r.coach_id && r.block_date >= today)
    const blocks = await readSummaryBlocks(db, [...new Set(future.map((r) => r.block_id).filter(Boolean))])
    const rowsByCoach = new Map()
    for (const r of future) {
      if (!rowsByCoach.has(r.coach_id)) rowsByCoach.set(r.coach_id, [])
      rowsByCoach.get(r.coach_id).push(r)
    }
    const byCoach = new Map()
    for (const [coachId, list] of rowsByCoach) {
      const items = summariseCoachChanges(list, blocks, coachId)
      if (items.length) byCoach.set(coachId, items)
    }
    return { rows, byCoach }
  } catch (e) {
    logWarn('roster-notify', 'change summary could not be planned; left for the next publish', { locationId, err: e?.message })
    return null
  }
}

/**
 * SCHEDULE-CHANGE-LOG.1 / NOTIFY.1 / PUBSUMMARY.1 — at Publish, tell each
 * coach about every change to a shift they already had, in ONE message
 * listing them (the email lists them all, the push names the first two).
 * Called by BOTH publish paths, through notifyRosterPublished: POST
 * /api/schedule/rosters and POST /api/schedule/rosters/[id]/approve. Best-effort;
 * never throws.
 *
 * Sent under `schedule` (push with email fallback). Every collected row is
 * stamped whether or not the message landed, so nothing is told twice —
 * EXCEPT a coach whose send hit a failed read inside notifyUsers that left
 * someone untold (C16 PUSHREADERR.1), or who `toldCoachIds` names in
 * `lostCoachIds`: their rows stay for the next publish. A duplicate beats a
 * loss.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} range
 * @param {string} range.locationId
 * @param {string} range.periodStart
 * @param {string} range.periodEnd
 * @param {string} [range.todayStr]  'YYYY-MM-DD' to treat as "today"; defaults
 *   to the STUDIO's day (TZ.8a). Tests pass this to pin the boundary.
 * @param {object|null} [range.plan]  planChangeSummaries' result, when the
 *   caller already has it (notifyRosterPublished).
 * @param {{ coachIds?: string[], lostCoachIds?: string[] }} [range.told]
 *   notifyStaffOfPublish's result: those coaches already had their changes
 *   in the "New schedule published" message.
 * @returns {Promise<{ notified: number }>} coaches TARGETED here.
 */
export async function renotifyChangedCoaches(db, { locationId, periodStart, periodEnd, todayStr, plan, told = {} }) {
  try {
    const p = plan === undefined ? await planChangeSummaries(db, { locationId, periodStart, periodEnd, todayStr }) : plan
    if (!p) return { notified: 0 }
    const alreadyTold = new Set(told.coachIds || [])
    const keep = new Set(told.lostCoachIds || [])
    let notified = 0
    for (const [coachId, items] of p.byCoach) {
      if (alreadyTold.has(coachId)) continue
      const { title, body, emailLines } = buildChangeSummaryMessage(items)
      // notifyUsers is documented never to throw; if it ever does, this
      // coach's rows are kept and the rest of the roster is still told.
      let totals = null
      try {
        totals = await notifyUsers([coachId], {
          title,
          body,
          emailLines,
          category: 'schedule',
          emailSubject: title,
          data: { type: 'schedule_updated', start_date: periodStart, end_date: periodEnd, block_date: items[0].blockDate, location_id: locationId },
        })
      } catch (e) {
        logWarn('roster-notify', 'change summary send threw', { locationId, coachId, err: e?.message })
      }
      notified++
      if (!totals || readLostSomeone(totals)) keep.add(coachId)
    }
    if (keep.size > 0) {
      logWarn('roster-notify', 'change summary may not have reached some coaches; their rows are left for the next publish', {
        locationId, coaches: keep.size,
      })
    }
    await markChangesNotified(db, p.rows.filter((r) => !keep.has(r.coach_id)).map((r) => r.id))
    return { notified }
  } catch (e) {
    logWarn('roster-notify', 'change summary failed', { locationId, err: e?.message })
    return { notified: 0 }
  }
}

/**
 * PUBSUMMARY.1 — the whole of a publish's staff messaging, for both publish
 * paths: coaches on newly published shifts hear "New schedule published"
 * (with any changes to shifts they already had folded in), and every other
 * coach with changes hears one "Roster updated" summary. One message per
 * coach per publish. Best-effort; never throws.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{ newBlockIds: string[], locationId: string, periodStart: string, periodEnd: string, todayStr?: string }} opts
 * @returns {Promise<{ notified: number }>} distinct coaches TARGETED.
 */
export async function notifyRosterPublished(db, { newBlockIds, locationId, periodStart, periodEnd, todayStr }) {
  const flipped = await publishNotifyRowsForBlocks(db, newBlockIds)
  const plan = await planChangeSummaries(db, { locationId, periodStart, periodEnd, todayStr })
  let first = { notified: 0, coachIds: [], lostCoachIds: [] }
  try {
    first = await notifyStaffOfPublish(db, flipped, {
      startDate: periodStart,
      endDate: periodEnd,
      locationId,
      changeSummaries: plan?.byCoach ?? null,
    })
  } catch (e) {
    logWarn('roster-notify', 'publish notify failed', { locationId, err: e?.message })
  }
  // With no plan (the studio's day unreadable) nothing is sent or stamped
  // here: the changes wait for the next publish.
  const rest = plan ? await renotifyChangedCoaches(db, { locationId, periodStart, periodEnd, plan, told: first }) : { notified: 0 }
  return { notified: (first?.notified || 0) + (rest?.notified || 0) }
}
