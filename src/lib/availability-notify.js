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
// the save. The route calls deliverOwedAvailabilityNotices straight after a
// save; in band it sends, otherwise the change rows stay un-notified and the
// checklist-sweep cron's arm (runAvailabilityNoticeSweep) sends them on the
// first tick at or after 07:00. BOTH paths fold every change still owed for a
// coach into ONE notice (foldChanges: the oldest before, the newest after,
// every id settled), so managers never see the newest state first and an
// older one after it, and a later save that undoes an owed one is settled
// 'reverted' with nobody pushed.
// Older than 24h: dropped as stale (the swap expiry notice's rule).
//
// ONCE, AND NEVER LOST: sendPushOnce CLAIMS (event key, recipient) in
// push_event_sends BEFORE it sends, and that claim has no lease. So a process
// that dies between the claim and the send (Vercel freezing the save's
// after()) leaves a claim with no push behind it, and a retry under the SAME
// key would be deduped to nothing and then stamped 'sent': a silent loss
// (CLAUDE.md BAREWRITE (c)). The lease lives here instead:
//   * the save's own attempt uses the plain key 'availability_changed:<id>';
//   * the sweep leaves a coach alone while their newest owed change is younger
//     than AVAILABILITY_NOTICE_LEASE_MS (that attempt may still be running);
//   * after that, the sweep sends under a RETRY key, 'availability_changed:
//     <id>:r<slot>', fresh for every 15-minute tick slot, so neither a dead
//     save nor a sweep that dies mid-send can swallow the notice.
// The price is a possible DUPLICATE (a push that landed but whose stamp was
// lost is sent again next tick), never a loss. Within one attempt the key
// still dedups: a manager at both studios gets one push. notified_at is
// stamped AFTER the send. A push that failed outright is not stamped, so a
// later tick retries it inside the 24h window.
//
// KNOWN LIMIT: a coach whose studios straddle 07:00 in different timezones is
// sent to the in-band studios and left owed for the rest; each later tick
// re-sends under a new retry key until every studio is in band. Every studio
// is Europe/Dublin today, so this cannot happen yet.

import { sendPushOnce } from '@/lib/push-dedup'
import { inStaffPushHours, resolveStaffTimeZone } from '@/lib/staff-push-hours'
import { RUNWAY_NOTIFY_ROLES } from '@/lib/roster-runway-notify'
import { diffAvailability, sameAvailability, describeRule } from '@shared/availability'
import { logWarn, logError } from '@/lib/log'

export const AVAILABILITY_NOTIFY_ROLES = RUNWAY_NOTIFY_ROLES
export const AVAILABILITY_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const AVAILABILITY_SWEEP_BATCH = 200
// The save's own attempt owns an owed change for this long (it runs in the
// route's after(), seconds at most); the */15 sweep waits it out.
export const AVAILABILITY_NOTICE_LEASE_MS = 10 * 60 * 1000
// One retry key per cron tick slot: concurrent sweeps in one slot dedup
// against each other, and the next slot gets a fresh key.
export const AVAILABILITY_RETRY_SLOT_MS = 15 * 60 * 1000
export const availabilityEventKey = (changeId) => `availability_changed:${changeId}`
export const availabilityRetryKey = (changeId, nowMs) =>
  `availability_changed:${changeId}:r${Math.floor(nowMs / AVAILABILITY_RETRY_SLOT_MS)}`

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

async function readRecipients(db, locationIds, excludeIds) {
  const { data, error } = await db
    .from('profile_locations')
    .select('profile_id, location_id, role, profiles!inner(id, role, active)')
    .in('location_id', locationIds)
  if (error) return { ids: null, error }
  const ids = new Set()
  for (const l of data || []) {
    // mig 626's staff predicate: `active IS NOT FALSE` (a NULL active counts).
    if (!l?.profiles || l.profiles.active === false || excludeIds.includes(l.profile_id)) continue
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
 * One coach's owed change rows, OLDEST FIRST, as one notice: the oldest
 * before-snapshot against the newest after-snapshot, the newest id and
 * created_at, every id to settle, and the actor only when all rows share one.
 */
export function foldChanges(rows) {
  const first = rows[0]
  const last = rows[rows.length - 1]
  return {
    id: last.id,
    ids: rows.map((x) => x.id),
    profile_id: last.profile_id,
    actor_id: new Set(rows.map((x) => x.actor_id)).size === 1 ? (last.actor_id ?? null) : null,
    before: first.before,
    after: last.after,
    created_at: last.created_at,
  }
}

/**
 * Tell the managers about one change (or, from the sweep, one coach's folded
 * changes: `ids` lists every row it settles, `id` is the newest).
 * Never throws. status: sent | deferred | stale | reverted | no_recipients | error.
 */
export async function deliverAvailabilityNotice(db, change, { nowMs = Date.now(), eventKey = null } = {}) {
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

    // Never the coach, and never the person who made the change (a master
    // under View as user): they know. change.actor_id is set only when every
    // folded change had the same actor.
    const exclude = [change.profile_id, change.actor_id].filter(Boolean)
    const { ids: recipients, error: recipientError } = await readRecipients(db, inBand.map((s) => s.id), exclude)
    if (recipientError) {
      logError('availability-notify', 'could not read the recipients', { change_id: change.id, err: recipientError.message })
      return { status: 'error', sent: 0 }
    }

    let sent = 0
    let failedOutright = false
    let fullyDeduped = false
    if (recipients.length > 0) {
      // A failed name read only costs the name ("A coach"), never the notice.
      const { data: person } = await db.from('profiles').select('full_name').eq('id', change.profile_id).maybeSingle()
      const { title, body } = availabilityNoticeText({ coachName: person?.full_name, before: change.before, after: change.after })
      const r = await sendPushOnce(db, eventKey || availabilityEventKey(change.id), recipients, {
        title,
        body,
        category: 'availability_change',
        data: { type: 'availability_changed', profile_id: change.profile_id, change_id: change.id },
      })
      sent = r?.sent || 0
      failedOutright = (r?.failed || 0) > 0 && sent === 0
      // Every recipient was already claimed under this key by ANOTHER attempt
      // (two saves folding to the same newest change, two sweeps in one slot).
      // That attempt may still fail or die after its claim, so this one must
      // not stamp: the claim-holder stamps, or the next slot's retry key
      // sends it again (a duplicate at worst, never a loss).
      fullyDeduped = sent === 0 && (r?.failed || 0) === 0 && (r?.deduped || 0) >= recipients.length
    }
    // A studio still in quiet hours, or a push that failed outright: leave it
    // owed for a later tick (see KNOWN LIMIT in the header).
    if (quiet.length > 0 || failedOutright || fullyDeduped) return { status: 'deferred', sent }
    return settle(db, ids, recipients.length > 0 ? 'sent' : 'no_recipients', nowMs, sent)
  } catch (err) {
    logError('availability-notify', 'deliver threw', { change_id: change?.id, err: err?.message })
    return { status: 'error', sent: 0 }
  }
}

/**
 * The save's own attempt (the route's after()): every change still owed for
 * this coach, folded, under the NEWEST change's plain key (a key nothing has
 * claimed yet). Never throws. status as deliverAvailabilityNotice, plus
 * 'none' when nothing is owed any more.
 */
export async function deliverOwedAvailabilityNotices(db, profileId, { nowMs = Date.now() } = {}) {
  try {
    const { data, error } = await db
      .from('staff_availability_changes')
      .select('id, profile_id, actor_id, before, after, created_at')
      .eq('profile_id', profileId)
      .is('notified_at', null)
      .order('created_at', { ascending: true })
      .limit(AVAILABILITY_SWEEP_BATCH)
    if (error) {
      // The sweep picks it up once the lease has run out.
      logError('availability-notify', "could not read the coach's owed notices", { profile_id: profileId, err: error.message })
      return { status: 'error', sent: 0 }
    }
    if (!data || data.length === 0) return { status: 'none', sent: 0 }
    return await deliverAvailabilityNotice(db, foldChanges(data), { nowMs })
  } catch (err) {
    logError('availability-notify', 'deliver owed threw', { profile_id: profileId, err: err?.message })
    return { status: 'error', sent: 0 }
  }
}

/**
 * The checklist-sweep cron's third arm: every notice still owed, one per
 * coach. Never throws; `errors` > 0 keeps its heartbeat from stamping.
 */
export async function runAvailabilityNoticeSweep(db, { nowMs = Date.now() } = {}) {
  const out = { pending: 0, groups: 0, leased: 0, sent: 0, deferred: 0, stale: 0, reverted: 0, no_recipients: 0, errors: 0 }
  const { data, error } = await db
    .from('staff_availability_changes')
    .select('id, profile_id, actor_id, before, after, created_at')
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
    const last = rows[rows.length - 1]
    // Inside the lease the save's own attempt may still be sending; leave it.
    const lastMs = Date.parse(last.created_at)
    if (Number.isFinite(lastMs) && nowMs - lastMs < AVAILABILITY_NOTICE_LEASE_MS) {
      out.leased++
      continue
    }
    const r = await deliverAvailabilityNotice(db, foldChanges(rows), { nowMs, eventKey: availabilityRetryKey(last.id, nowMs) })
    if (r.status === 'error') out.errors++
    else out[r.status] = (out[r.status] || 0) + 1
  }
  return out
}
