// NOTIF.1 + NOTIF.3 — push reminder cron.
//
// Runs every 5 minutes. Scans for tasks and bookings whose due/start
// time falls in any of their location's configured lead-time windows
// (default: 60 min and 1440 min before due, configurable per-location
// via locations.notification_config — mig 170).
//
// The fire window around each lead time is ASYMMETRIC: up to 5 min
// early but up to 15 min late. A symmetric ±5 window (matching the
// 5-minute cron tick) meant two consecutive missed Vercel cron ticks
// silently lost the reminder forever — by the next successful tick it
// was outside the window and had never reached the ledger, so nothing
// ever retried it. The 15-min late side gives up to three missed ticks
// a catch-up runway (a reminder 15 min late still beats no reminder);
// the push_reminder_sends ledger (mig 169) guarantees we never
// double-send via UNIQUE (entity, recipient, lead_time_minutes).
//
// Routing:
//   - Tasks (activities WHERE kind='task' AND status IN ('todo',
//     'in_progress') AND assignee_id IS NOT NULL) → push to the
//     assignee only, category='tasks'.
//   - Bookings (status='confirmed', no skip_reminder) → push to all
//     users with the location's configured booking roles
//     (default owner/manager/head_coach), category='bookings'.
//
// Bookings fan out to a role-set rather than a single staff member
// because the bookings table has no "assigned coach" column — the
// staff member who runs each session is determined by
// shift_assignments, which we don't want to denormalise here.
//
// Auth: CRON_SECRET bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPush } from '@/lib/push'
import { logInfo, logWarn, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { localToUtc, formatLocalTime } from '@/lib/push-reminders'
import { getEffectiveConfig, getEffectiveLeadTimesForUser } from '@/lib/notification-config'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_MIN = 5       // fire up to 5 min EARLY (matches the cron tick)
const LATE_WINDOW_MIN = 15 // fire up to 15 min LATE — catch-up runway for missed cron ticks

// True when `minutesAway` (minutes until the entity is due) is inside
// the asymmetric fire window for `lead`: [lead - LATE_WINDOW_MIN,
// lead + WINDOW_MIN]. Once now is past (due - lead + LATE_WINDOW_MIN)
// the pair stops matching — that's also the natural cap on Fix-C send
// retries (a permanently-failing send retries for at most ~15 min,
// then falls out of the window).
function inFireWindow(minutesAway, lead) {
  const delta = minutesAway - lead // > 0 = early, < 0 = late
  return delta <= WINDOW_MIN && delta >= -LATE_WINDOW_MIN
}

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()
  const nowMs = now.getTime()

  // Pull location configs upfront. One round-trip; locations are
  // few (single-digit) so this is cheap regardless of size.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, timezone, notification_config')

  if (locErr) {
    logError('cron-push-reminders', 'location fetch failed', { err: locErr })
    return NextResponse.json({ ok: false, error: locErr.message }, { status: 500 })
  }

  // Per-location effective config + the union of all lead times
  // across all locations (used to bound our DB queries).
  const locById = new Map()
  let maxLeadMinutes = 0
  for (const l of locations || []) {
    const cfg = getEffectiveConfig(l.notification_config)
    locById.set(l.id, { tz: l.timezone || 'Europe/Dublin', cfg })
    for (const cat of ['tasks', 'bookings']) {
      for (const lt of cfg.categories?.[cat]?.lead_times_minutes || []) {
        if (lt > maxLeadMinutes) maxLeadMinutes = lt
      }
    }
  }

  // DB-side time window: anything due between now-15min (late catch-up)
  // and now+max+5min could be in *some* location's lead-time window.
  // We refine in JS.
  const fetchLowerDate = new Date(nowMs - LATE_WINDOW_MIN * 60 * 1000)
  const fetchUpperDate = new Date(nowMs + (maxLeadMinutes + WINDOW_MIN) * 60 * 1000)
  const fetchLowerDay = fetchLowerDate.toISOString().slice(0, 10)
  const fetchUpperDay = fetchUpperDate.toISOString().slice(0, 10)

  const summary = {
    task_candidates: 0,
    task_pushed: 0,
    task_skipped_dup: 0,
    task_skipped_no_recipient: 0,
    task_send_failed: 0,
    booking_candidates: 0,
    booking_pushed: 0,
    booking_skipped_dup: 0,
    booking_send_failed: 0,
    lead_time_buckets: [], // for logging / debugging
  }

  // -------------------------- TASKS --------------------------
  //
  // NOTIF.7 — assignee-level lead-time overrides supported. If the
  // assignee has set lead_time_overrides.tasks on their mobile
  // permissions, we use that; otherwise fall back to the location's
  // notification_config; otherwise the built-in default [60, 1440].
  // Bookings stay location-only (operator on-duty preference, not
  // personal).
  try {
    // PAGED: an un-paginated select caps at 1000, silently DROPPING every task
    // reminder past the first 1000 due-window rows. Page the full set (order by
    // id so paging is stable).
    let tasks = null
    let tErr = null
    try {
      tasks = await selectAll((from, to) => db
        .from('activities')
        .select('id, subject, assignee_id, location_id, due_date, due_time')
        .eq('kind', 'task')
        .in('status', ['todo', 'in_progress'])
        .not('assignee_id', 'is', null)
        .not('due_date', 'is', null)
        .gte('due_date', fetchLowerDay)
        .lte('due_date', fetchUpperDay)
        .order('id', { ascending: true })
        .range(from, to))
    } catch (e) { tErr = e }

    if (tErr) {
      logError('cron-push-reminders', 'task fetch failed', { err: tErr })
    } else if (tasks && tasks.length > 0) {
      // Batch-fetch the assignees' mobile permissions for THIS LOCATION.
      // Mobile permissions live on profile_locations.permissions (not
      // on profiles.permissions) — they're per (user × location). The
      // task's location_id determines which row to read for that user.
      const assigneeIds = [...new Set(tasks.map(t => t.assignee_id))]
      const locationIds = [...new Set(tasks.map(t => t.location_id))]
      const { data: pls } = await db
        .from('profile_locations')
        .select('profile_id, location_id, permissions')
        .in('profile_id', assigneeIds)
        .in('location_id', locationIds)
      // Map keyed by `${profileId}|${locationId}` for O(1) lookup.
      const mobilePermsByPair = new Map(
        (pls || []).map(pl => [`${pl.profile_id}|${pl.location_id}`, pl.permissions?.mobile || {}])
      )

      for (const t of tasks) {
        const loc = locById.get(t.location_id)
        if (!loc) continue
        const userPerms = mobilePermsByPair.get(`${t.assignee_id}|${t.location_id}`) || {}
        const leadTimes = getEffectiveLeadTimesForUser(
          loc.cfg ? { categories: loc.cfg.categories } : null,
          userPerms,
          'tasks',
        )
        // Fall back to the location config getter if the helper
        // returned empty (shouldn't happen — built-in default kicks in
        // — but defensive).
        if (!leadTimes.length) continue

        const dueUtc = localToUtc(t.due_date, t.due_time || '09:00:00', loc.tz)
        if (!dueUtc) continue
        const minutesAway = (dueUtc.getTime() - nowMs) / 60000

        for (const lead of leadTimes) {
          if (!inFireWindow(minutesAway, lead)) continue
          summary.task_candidates++

          // Per-(task, assignee, lead) dedup.
          const { data: existing } = await db
            .from('push_reminder_sends')
            .select('id')
            .eq('entity_type', 'task')
            .eq('entity_id', t.id)
            .eq('recipient_id', t.assignee_id)
            .eq('lead_time_minutes', lead)
            .maybeSingle()
          if (existing) { summary.task_skipped_dup++; continue }

          const label = leadLabel(lead)
          const result = await sendPush([t.assignee_id], {
            title: `Task due ${label}`,
            body: t.subject || 'Untitled task',
            category: 'tasks',
            data: { type: 'task_reminder', task_id: t.id, lead_minutes: lead },
          })

          // Ledger only when the send didn't outright FAIL. sent=0 with
          // failed=0 means "nothing to send" (opt-out / no tokens) — write
          // the row so we don't re-check forever. sent=0 with failed>0
          // means the Expo pipeline fell over after retries — skip the
          // row so the next tick retries; the late fire-window bounds how
          // long a permanently-failing send can keep retrying (~15 min).
          const sendFailed = (result.sent || 0) === 0 && (result.failed || 0) > 0
          if (sendFailed) {
            summary.task_send_failed++
            logWarn('cron-push-reminders', 'task push send failed — ledger skipped for retry', { t: t.id, lead })
            continue
          }

          const { error: ledgerErr } = await db.from('push_reminder_sends').insert({
            entity_type: 'task',
            entity_id: t.id,
            recipient_id: t.assignee_id,
            lead_time_minutes: lead,
            push_count: result.sent || 0,
            push_invalidated: result.invalidated || 0,
          })
          if (ledgerErr && ledgerErr.code !== '23505') {
            logWarn('cron-push-reminders', 'task ledger insert failed', { err: ledgerErr, t: t.id })
          }

          if (result.sent > 0) summary.task_pushed++
          else summary.task_skipped_no_recipient++
        }
      }
    }
  } catch (err) {
    logError('cron-push-reminders', 'task block threw', { err })
  }

  // -------------------------- BOOKINGS --------------------------
  try {
    // PAGED: an un-paginated select caps at 1000, silently DROPPING every
    // booking reminder past the first 1000 due-window rows. Page the full set
    // (order by id so paging is stable).
    let bookings = null
    let bErr = null
    try {
      bookings = await selectAll((from, to) => db
        .from('bookings')
        .select(`
          id, customer_name, booking_date, start_time, status, location_id, skip_reminder,
          event_type:event_types(name)
        `)
        .eq('status', 'confirmed')
        .eq('skip_reminder', false)
        .gte('booking_date', fetchLowerDay)
        .lte('booking_date', fetchUpperDay)
        .order('id', { ascending: true })
        .range(from, to))
    } catch (e) { bErr = e }

    // NOTIF.10 — loop inverted to support per-user lead-time
    // overrides. For each booking, resolve the role-set, fetch each
    // recipient's profile_locations.permissions.mobile, then for
    // EACH recipient walk their effective lead times and decide
    // whether to fire. Previously the lead-times were the outer
    // loop (one set per location); now they're per-recipient.
    if (bErr) {
      logError('cron-push-reminders', 'booking fetch failed', { err: bErr })
    } else if (bookings && bookings.length > 0) {
      // Batch-fetch all candidate recipients' permissions across the
      // location set, keyed on (profile_id, location_id). The
      // (notify_roles, active) filtering still happens per-booking
      // but we avoid N round-trips by pulling them all up front.
      const bookingLocIds = [...new Set(bookings.map(b => b.location_id).filter(Boolean))]
      const { data: locLinks } = await db
        .from('profile_locations')
        .select('profile_id, location_id, permissions, profiles!inner(id, role, active)')
        .in('location_id', bookingLocIds)
      const recipientsByLocation = new Map() // location_id -> [{ profile_id, role, perms }]
      for (const link of locLinks || []) {
        if (!link.profiles?.active) continue
        if (!recipientsByLocation.has(link.location_id)) recipientsByLocation.set(link.location_id, [])
        recipientsByLocation.get(link.location_id).push({
          profile_id: link.profile_id,
          role: link.profiles.role,
          perms: link.permissions?.mobile || {},
        })
      }

      for (const b of bookings) {
        if (!b.location_id || !b.booking_date || !b.start_time) continue
        const loc = locById.get(b.location_id)
        if (!loc) continue
        const notifyRoles = loc.cfg.categories?.bookings?.notify_roles || []
        if (!notifyRoles.length) continue

        const startUtc = localToUtc(b.booking_date, b.start_time, loc.tz)
        if (!startUtc) continue
        const minutesAway = (startUtc.getTime() - nowMs) / 60000

        const candidates = (recipientsByLocation.get(b.location_id) || [])
          .filter(r => notifyRoles.includes(r.role))
        if (!candidates.length) continue

        const eventName = b.event_type?.name || 'booking'

        // For each recipient, walk THEIR effective lead times and
        // check the window. A recipient with a 30-min override at
        // a location that defaults to 60-min will fire at the
        // 30-min mark instead.
        for (const recipient of candidates) {
          const leadTimes = getEffectiveLeadTimesForUser(
            loc.cfg ? { categories: loc.cfg.categories } : null,
            recipient.perms,
            'bookings',
          )
          if (!leadTimes.length) continue

          for (const lead of leadTimes) {
            if (!inFireWindow(minutesAway, lead)) continue
            summary.booking_candidates++

            // Dedup per (booking, recipient, lead).
            const { data: existing } = await db
              .from('push_reminder_sends')
              .select('id')
              .eq('entity_type', 'booking')
              .eq('entity_id', b.id)
              .eq('recipient_id', recipient.profile_id)
              .eq('lead_time_minutes', lead)
              .maybeSingle()
            if (existing) { summary.booking_skipped_dup++; continue }

            const label = leadLabel(lead)
            const result = await sendPush([recipient.profile_id], {
              title: `${eventName} ${label}`,
              body: `${b.customer_name || 'Guest'} · ${formatLocalTime(b.start_time)}`,
              category: 'bookings',
              data: { type: 'booking_reminder', booking_id: b.id, lead_minutes: lead },
            })

            // Same failed-vs-nothing-to-send split as the task block:
            // a pipeline failure (sent=0, failed>0) skips the ledger so
            // the next tick retries inside the late window; an opt-out /
            // no-token zero still writes the row.
            const sendFailed = (result.sent || 0) === 0 && (result.failed || 0) > 0
            if (sendFailed) {
              summary.booking_send_failed++
              logWarn('cron-push-reminders', 'booking push send failed — ledger skipped for retry', { b: b.id, lead })
              continue
            }

            const { error: ledgerErr } = await db.from('push_reminder_sends').insert({
              entity_type: 'booking',
              entity_id: b.id,
              recipient_id: recipient.profile_id,
              lead_time_minutes: lead,
              push_count: result.sent || 0,
              push_invalidated: result.invalidated || 0,
            })
            if (ledgerErr && ledgerErr.code !== '23505') {
              logWarn('cron-push-reminders', 'booking ledger insert failed', { err: ledgerErr, b: b.id })
            }

            if (result.sent > 0) summary.booking_pushed++
          }
        }
      }
    }
  } catch (err) {
    logError('cron-push-reminders', 'booking block threw', { err })
  }

  if (Object.values(summary).some(v => Array.isArray(v) ? v.length > 0 : v > 0)) {
    logInfo('cron-push-reminders', 'tick', summary)
  }

  await stampHeartbeat('send-push-reminders').catch((err) =>
    logWarn('cron-push-reminders', 'heartbeat failed', { err }))

  return NextResponse.json({ ok: true, ...summary })
}

// Human-friendly label for a lead-time in minutes. Used as the
// notification title suffix ("Task due in 1 hour", "Task due
// tomorrow"). Falls back to a relative string for non-canonical
// lead times the operator configured ("in 30m", "in 4d").
function leadLabel(minutes) {
  if (minutes === 60)   return 'in 1 hour'
  if (minutes === 1440) return 'tomorrow'
  if (minutes < 60)     return `in ${minutes}m`
  if (minutes % 1440 === 0) {
    const d = minutes / 1440
    return d === 1 ? 'tomorrow' : `in ${d} days`
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return `in ${h} hours`
  }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `in ${h}h${m}m`
}
