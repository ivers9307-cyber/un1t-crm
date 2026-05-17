// NOTIF.1 + NOTIF.3 — push reminder cron.
//
// Runs every 5 minutes. Scans for tasks and bookings whose due/start
// time falls in any of their location's configured lead-time windows
// (default: 60 min and 1440 min before due, configurable per-location
// via locations.notification_config — mig 170).
//
// The ±5 min spread around each lead time is wider than the 5-minute
// cron tick so we never miss a row sitting on the boundary; the
// push_reminder_sends ledger (mig 169) guarantees we never
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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_MIN = 5 // ±5 min around each target lead time

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
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

  // DB-side time window: anything due between now+5min and now+max+5min
  // could be in *some* location's lead-time window. We refine in JS.
  const fetchLowerDate = new Date(nowMs - WINDOW_MIN * 60 * 1000)
  const fetchUpperDate = new Date(nowMs + (maxLeadMinutes + WINDOW_MIN) * 60 * 1000)
  const fetchLowerDay = fetchLowerDate.toISOString().slice(0, 10)
  const fetchUpperDay = fetchUpperDate.toISOString().slice(0, 10)

  const summary = {
    task_candidates: 0,
    task_pushed: 0,
    task_skipped_dup: 0,
    task_skipped_no_recipient: 0,
    booking_candidates: 0,
    booking_pushed: 0,
    booking_skipped_dup: 0,
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
    const { data: tasks, error: tErr } = await db
      .from('activities')
      .select('id, subject, assignee_id, location_id, due_date, due_time')
      .eq('kind', 'task')
      .in('status', ['todo', 'in_progress'])
      .not('assignee_id', 'is', null)
      .not('due_date', 'is', null)
      .gte('due_date', fetchLowerDay)
      .lte('due_date', fetchUpperDay)

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
          if (Math.abs(minutesAway - lead) > WINDOW_MIN) continue
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

          await db.from('push_reminder_sends').insert({
            entity_type: 'task',
            entity_id: t.id,
            recipient_id: t.assignee_id,
            lead_time_minutes: lead,
            push_count: result.sent || 0,
            push_invalidated: result.invalidated || 0,
          }).then(({ error }) => {
            if (error && error.code !== '23505') {
              logWarn('cron-push-reminders', 'task ledger insert failed', { err: error, t: t.id })
            }
          })

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
    const { data: bookings, error: bErr } = await db
      .from('bookings')
      .select(`
        id, customer_name, booking_date, start_time, status, location_id, skip_reminder,
        event_type:event_types(name)
      `)
      .eq('status', 'confirmed')
      .eq('skip_reminder', false)
      .gte('booking_date', fetchLowerDay)
      .lte('booking_date', fetchUpperDay)

    if (bErr) {
      logError('cron-push-reminders', 'booking fetch failed', { err: bErr })
    } else {
      for (const b of bookings || []) {
        if (!b.location_id || !b.booking_date || !b.start_time) continue
        const loc = locById.get(b.location_id)
        if (!loc) continue
        const leadTimes = loc.cfg.categories?.bookings?.lead_times_minutes || []
        if (!leadTimes.length) continue
        const notifyRoles = loc.cfg.categories?.bookings?.notify_roles || []
        if (!notifyRoles.length) continue

        const startUtc = localToUtc(b.booking_date, b.start_time, loc.tz)
        if (!startUtc) continue
        const minutesAway = (startUtc.getTime() - nowMs) / 60000

        for (const lead of leadTimes) {
          if (Math.abs(minutesAway - lead) > WINDOW_MIN) continue
          summary.booking_candidates++

          // Resolve recipient set at this location with the
          // configured roles.
          const { data: links } = await db
            .from('profile_locations')
            .select('profile_id, profiles!inner(id, role, active)')
            .eq('location_id', b.location_id)

          const recipientIds = (links || [])
            .filter(l => l.profiles?.active && notifyRoles.includes(l.profiles.role))
            .map(l => l.profile_id)
          if (!recipientIds.length) continue

          // Per-recipient dedup.
          const { data: alreadySent } = await db
            .from('push_reminder_sends')
            .select('recipient_id')
            .eq('entity_type', 'booking')
            .eq('entity_id', b.id)
            .eq('lead_time_minutes', lead)
            .in('recipient_id', recipientIds)

          const alreadySetIds = new Set((alreadySent || []).map(r => r.recipient_id))
          const fresh = recipientIds.filter(id => !alreadySetIds.has(id))
          summary.booking_skipped_dup += alreadySetIds.size
          if (!fresh.length) continue

          const eventName = b.event_type?.name || 'booking'
          const label = leadLabel(lead)
          const result = await sendPush(fresh, {
            title: `${eventName} ${label}`,
            body: `${b.customer_name || 'Guest'} · ${formatLocalTime(b.start_time)}`,
            category: 'bookings',
            data: { type: 'booking_reminder', booking_id: b.id, lead_minutes: lead },
          })

          const rows = fresh.map(rid => ({
            entity_type: 'booking',
            entity_id: b.id,
            recipient_id: rid,
            lead_time_minutes: lead,
            push_count: 1,
            push_invalidated: 0,
          }))
          await db.from('push_reminder_sends').insert(rows).then(({ error }) => {
            if (error && error.code !== '23505') {
              logWarn('cron-push-reminders', 'booking ledger insert failed', { err: error, b: b.id })
            }
          })

          if (result.sent > 0) summary.booking_pushed++
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
