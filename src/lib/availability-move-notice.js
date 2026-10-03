// src/lib/availability-move-notice.js
//
// AVAIL.3 — the ONE-TIME notice to the people whose Unavailable time-off
// requests the mig 703 move carried into availability (Richard, 3 Oct 2026:
// "tell them to update to the latest version to use this feature"). The move
// itself is SQL and sends nothing; this is run by the operator right after
// it, through POST /api/admin/availability-move-notice (master only).
//
// Quiet hours gate the NOTICE, never the STATE: the days have already moved;
// a person whose studio clock is outside 07:00-22:00 is skipped (deferred)
// and the operator runs it again later. One push per person EVER
// (push_event_sends key availability_moved:<profile_id>), so a re-run, a
// straggler batch or a double click tells nobody twice.
//
// Categoryless on purpose: an operational notice, not a preference, so only
// the person's master switch and device permission gate it (CLAUDE.md: an
// unregistered category fails closed). data.type 'availability_moved' opens
// My availability on a 2.4.0 phone (mobile/lib/notification-nav.js); a 2.3.x
// phone just opens the app, and the words tell them to update.
//
// The words are the default below; the operator may send different words in
// the request body (checked by the same rules), so changing them needs no
// deploy.

import { sendPushOnce } from './push-dedup'
import { inStaffPushHours, resolveStaffTimeZone } from './staff-push-hours'
import { logWarn } from './log'

export const AVAILABILITY_MOVE_NOTICE = Object.freeze({
  title: 'Your unavailable days have moved',
  body: 'Your unavailable days are now in My availability, on the Schedule screen. Update the Repset app to the latest version to see them.',
})

export const MOVE_NOTICE_TYPE = 'availability_moved'
const TITLE_MAX = 65
const BODY_MAX = 178

/** Why these words can't be sent, or null. No em dashes (Richard's rule). */
export function moveNoticeCopyProblem({ title, body } = {}) {
  if (typeof title !== 'string' || !title.trim()) return 'A title is required'
  if (typeof body !== 'string' || !body.trim()) return 'A body is required'
  if (title.length > TITLE_MAX) return `Keep the title to ${TITLE_MAX} characters`
  if (body.length > BODY_MAX) return `Keep the body to ${BODY_MAX} characters`
  if (/[—–]/.test(title) || /[—–]/.test(body)) return 'No em dashes in staff or customer messages'
  return null
}

/** Pure. One recipient per person from un-restored ledger rows: { profileId, locationId }. */
export function moveNoticeRecipients(ledgerRows) {
  const byPerson = new Map()
  for (const r of ledgerRows || []) {
    if (!r?.profile_id || r.restored_at) continue
    if (!byPerson.has(r.profile_id)) byPerson.set(r.profile_id, { profileId: r.profile_id, locationId: r.original?.location_id ?? null })
  }
  return [...byPerson.values()]
}

/**
 * Preview (send false, the default) or send the notice.
 * @returns {Promise<object>} counts only: never a name.
 */
export async function runAvailabilityMoveNotice(db, {
  nowMs = Date.now(), send = false, batchId = null,
  title = AVAILABILITY_MOVE_NOTICE.title, body = AVAILABILITY_MOVE_NOTICE.body,
} = {}) {
  const copyProblem = moveNoticeCopyProblem({ title, body })
  if (copyProblem) return { ok: false, error: copyProblem }

  let q = db
    .from('time_off_availability_moves')
    .select('time_off_request_id, batch_id, profile_id, original, restored_at')
    .is('restored_at', null)
  if (batchId) q = q.eq('batch_id', batchId)
  const { data: rows, error } = await q.order('moved_at', { ascending: true })
  if (error) return { ok: false, error: error.message || 'Could not read the move ledger' }

  const recipients = moveNoticeRecipients(rows)
  const locationIds = [...new Set(recipients.map((r) => r.locationId).filter(Boolean))]
  const zones = new Map()
  if (locationIds.length) {
    const { data: locs, error: locErr } = await db.from('locations').select('id, timezone').in('id', locationIds)
    // Unreadable zones are Dublin (every studio is today); logged, never fatal.
    if (locErr) logWarn('availability-move-notice', 'studio timezones unreadable; using Europe/Dublin', { err: locErr.message })
    for (const l of locs || []) zones.set(l.id, l.timezone)
  }
  const inHours = recipients.filter((r) => inStaffPushHours(nowMs, resolveStaffTimeZone(zones.get(r.locationId)).timeZone))
  const deferred = recipients.length - inHours.length

  if (!send) return { ok: true, send: false, recipients: recipients.length, inHours: inHours.length, deferred, title, body }

  const payload = { title, body, data: { type: MOVE_NOTICE_TYPE } }
  let sent = 0
  let failed = 0
  let deduped = 0
  let noDevice = 0
  for (const r of inHours) {
    const res = await sendPushOnce(db, `${MOVE_NOTICE_TYPE}:${r.profileId}`, [r.profileId], payload)
    sent += res?.sent || 0
    failed += res?.failed || 0
    deduped += res?.deduped || 0
    if (!res?.sent && !res?.failed && !res?.deduped) noDevice += 1
  }
  return { ok: true, send: true, recipients: recipients.length, sent, failed, deduped, noDevice, deferred }
}
