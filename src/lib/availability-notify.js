// src/lib/availability-notify.js
//
// AVAIL.1 — telling the managers that a coach changed their availability.
//
// WHO: the roster builders (owner, manager, head coach: the runway alert's
// roles) and masters linked to each studio the coach belongs to, active only,
// never the coach. Read here with its own query: resolveRoleRecipientIds
// (push.js) discards its read error, and "the read failed" must never be
// stamped as "nobody to tell".
//
// WHEN: staff quiet hours (src/lib/staff-push-hours.js) gate the NOTICE, never
// the save. The route calls deliverAvailabilityNotice straight after a save;
// in band it sends, otherwise the change row stays un-notified and the
// checklist-sweep cron's arm (runAvailabilityNoticeSweep) sends it on the
// first tick at or after 07:00. A coach's overnight saves become ONE notice.
// Older than 24h: dropped as stale (the swap expiry notice's rule).
//
// ONCE: sendPushOnce keyed 'availability_changed:<change id>', so the route,
// a retry and the sweep can never double-push; a manager at both studios gets
// one. notified_at is stamped AFTER the send (BAREWRITE (c): no claim-before-
// send without a lease). A push that failed outright is not stamped, so the
// next tick retries it inside the 24h window.

import { sendPushOnce } from '@/lib/push-dedup'
import { inStaffPushHours, resolveStaffTimeZone } from '@/lib/staff-push-hours'
import { RUNWAY_NOTIFY_ROLES } from '@/lib/roster-runway-notify'
import { diffAvailability, sameAvailability, describeRule } from '@shared/availability'
import { logWarn, logError } from '@/lib/log'

export const AVAILABILITY_NOTIFY_ROLES = RUNWAY_NOTIFY_ROLES
export const AVAILABILITY_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const AVAILABILITY_SWEEP_BATCH = 200
export const availabilityEventKey = (changeId) => `availability_changed:${changeId}`

function listRules(rules, max = 3) {
  const shown = rules.slice(0, max).map(describeRule)
  const more = rules.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** The push text. Pure. */
export function availabilityNoticeText({ coachName, before, after }) {
  const name = (typeof coachName === 'string' && coachName.trim()) || 'A coach'
  const { added, removed } = diffAvailability(before, after)
  const parts = []
  if (added.length) parts.push(`now unavailable ${listRules(added)}`)
  if (removed.length) parts.push(`available again ${listRules(removed)}`)
  return {
    title: 'Availability changed',
    body: parts.length ? `${name} is ${parts.join('; ')}.` : `${name} updated the notes on their availability.`,
  }
}

/** Studios whose wall clock is inside 07:00-22:00 now, and the rest. */
export function splitStudiosByBand(studios, nowMs) {
  const inBand = []
  const quiet = []
  for (const s of studios || []) {
    const { timeZone, warn } = resolveStaffTimeZone(s.timezone)
    if (warn) logWarn('availability-notify', 'studio timezone unreadable, using Europe/Dublin', { location_id: s.id })
    if (inStaffPushHours(nowMs, timeZone)) inBand.push(s)
    else quiet.push(s)
  }
  return { inBand, quiet }
}

async function readRecipients(db, locationIds, coachId) {
  const { data, error } = await db
    .from('profile_locations')
    .select('profile_id, location_id, role, profiles!inner(id, role, active)')
    .in('location_id', locationIds)
  if (error) return { ids: null, error }
  const ids = new Set()
  for (const l of data || []) {
    // mig 626's staff predicate: `active IS NOT FALSE` (a NULL active counts).
    if (!l?.profiles || l.profiles.active === false || l.profile_id === coachId) continue
    if (AVAILABILITY_NOTIFY_ROLES.includes(l.role) || l.profiles.role === 'master') ids.add(l.profile_id)
  }
  return { ids: [...ids], error: null }
}

async function settle(db, ids, outcome, nowMs, sent = 0) {
  const { error } = await db
    .from('staff_availability_changes')
    .update({ notified_at: new Date(nowMs).toISOString(), notice_outcome: outcome })
    .in('id', ids)
    .is('notified_at', null)
  if (error) {
    logError('availability-notify', 'could not stamp the notice', { ids, outcome, err: error.message })
    return { status: 'error', sent }
  }
  return { status: outcome, sent }
}

/**
 * Tell the managers about one change (or, from the sweep, one coach's folded
 * changes: `ids` lists every row it settles, `id` is the newest).
 * Never throws. status: sent | deferred | stale | reverted | no_recipients | error.
 */
export async function deliverAvailabilityNotice(db, change, { nowMs = Date.now() } = {}) {
  try {
    const ids = Array.isArray(change.ids) && change.ids.length ? change.ids : [change.id]
    const createdMs = Date.parse(change.created_at)
    if (Number.isFinite(createdMs) && nowMs - createdMs > AVAILABILITY_NOTICE_MAX_AGE_MS) return settle(db, ids, 'stale', nowMs)
    if (sameAvailability(change.before, change.after)) return settle(db, ids, 'reverted', nowMs)

    const { data: links, error: linkError } = await db
      .from('profile_locations')
      .select('location_id, locations!inner(id, timezone)')
      .eq('profile_id', change.profile_id)
    if (linkError) {
      logError('availability-notify', "could not read the coach's studios", { change_id: change.id, err: linkError.message })
      return { status: 'error', sent: 0 }
    }
    const studios = (links || []).filter((l) => l?.location_id).map((l) => ({ id: l.location_id, timezone: l.locations?.timezone ?? null }))
    if (studios.length === 0) return settle(db, ids, 'no_recipients', nowMs)

    const { inBand, quiet } = splitStudiosByBand(studios, nowMs)
    if (inBand.length === 0) return { status: 'deferred', sent: 0 }

    const { ids: recipients, error: recipientError } = await readRecipients(db, inBand.map((s) => s.id), change.profile_id)
    if (recipientError) {
      logError('availability-notify', 'could not read the recipients', { change_id: change.id, err: recipientError.message })
      return { status: 'error', sent: 0 }
    }

    let sent = 0
    let failedOutright = false
    if (recipients.length > 0) {
      // A failed name read only costs the name ("A coach"), never the notice.
      const { data: person } = await db.from('profiles').select('full_name').eq('id', change.profile_id).maybeSingle()
      const { title, body } = availabilityNoticeText({ coachName: person?.full_name, before: change.before, after: change.after })
      const r = await sendPushOnce(db, availabilityEventKey(change.id), recipients, {
        title,
        body,
        category: 'availability_change',
        data: { type: 'availability_changed', profile_id: change.profile_id, change_id: change.id },
      })
      sent = r?.sent || 0
      failedOutright = (r?.failed || 0) > 0 && sent === 0
    }
    // A studio still in quiet hours, or a push that failed outright: leave it
    // owed. The dedup key means the managers already told are never told twice.
    if (quiet.length > 0 || failedOutright) return { status: 'deferred', sent }
    return settle(db, ids, recipients.length > 0 ? 'sent' : 'no_recipients', nowMs, sent)
  } catch (err) {
    logError('availability-notify', 'deliver threw', { change_id: change?.id, err: err?.message })
    return { status: 'error', sent: 0 }
  }
}

/**
 * The checklist-sweep cron's third arm: every notice still owed, one per
 * coach. Never throws; `errors` > 0 keeps its heartbeat from stamping.
 */
export async function runAvailabilityNoticeSweep(db, { nowMs = Date.now() } = {}) {
  const out = { pending: 0, groups: 0, sent: 0, deferred: 0, stale: 0, reverted: 0, no_recipients: 0, errors: 0 }
  const { data, error } = await db
    .from('staff_availability_changes')
    .select('id, profile_id, before, after, created_at')
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(AVAILABILITY_SWEEP_BATCH)
  if (error) {
    logError('availability-notify', 'could not read the notice queue', { err: error.message })
    out.errors++
    return out
  }
  out.pending = (data || []).length
  const byCoach = new Map()
  for (const row of data || []) {
    if (!byCoach.has(row.profile_id)) byCoach.set(row.profile_id, [])
    byCoach.get(row.profile_id).push(row)
  }
  for (const rows of byCoach.values()) {
    out.groups++
    const first = rows[0]
    const last = rows[rows.length - 1]
    const r = await deliverAvailabilityNotice(db, {
      id: last.id,
      ids: rows.map((x) => x.id),
      profile_id: last.profile_id,
      before: first.before,
      after: last.after,
      created_at: last.created_at,
    }, { nowMs })
    if (r.status === 'error') out.errors++
    else out[r.status] = (out[r.status] || 0) + 1
  }
  return out
}
