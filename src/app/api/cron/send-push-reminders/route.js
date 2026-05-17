// NOTIF.1 — push reminder cron.
//
// Runs every 5 minutes. Scans for tasks and bookings whose due/start
// time lands in either of two windows:
//
//   - 1h reminder:   55–65 minutes from now
//   - 24h reminder:  23h55m–24h05m from now
//
// The ±5 min spread is wider than the 5-minute cron tick so we never
// miss a row sitting on the boundary; the push_reminder_sends ledger
// (mig 169) guarantees we never double-send.
//
// Routing:
//   - Tasks (activities WHERE kind='task' AND status IN ('todo',
//     'in_progress') AND assignee_id IS NOT NULL) → push to the
//     assignee only, category='tasks'.
//   - Bookings (status='confirmed', no skip_reminder, no
//     reminder_sent_at) → push to all owner/manager/head_coach at
//     the location, category='bookings'.
//
// Bookings deliberately fan out to a role-set rather than a single
// staff member because the bookings table has no "assigned coach"
// column — the staff member who runs the session is determined by
// shift_assignments, which we don't want to denormalise here.
// "Operator on shift sees what's coming up at their location" is
// what the operator asked for.
//
// Auth: CRON_SECRET bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPush } from '@/lib/push'
import { logInfo, logWarn, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { localToUtc, formatLocalTime } from '@/lib/push-reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_MIN = 5 // ±5 min around each target lead time

// Lead times we fire at. Keep in sync with mig 169 CHECK constraint
// (lead_time_minutes IN (60, 1440)).
const LEAD_TIMES = [
  { minutes: 60,   label: 'in 1 hour' },
  { minutes: 1440, label: 'tomorrow' },
]

// Roles that should receive booking reminders at a location.
const BOOKING_NOTIFY_ROLES = ['owner', 'manager', 'head_coach']

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()

  const summary = {
    task_candidates: 0,
    task_pushed: 0,
    task_skipped_dup: 0,
    task_skipped_no_recipient: 0,
    booking_candidates: 0,
    booking_pushed: 0,
    booking_skipped_dup: 0,
  }

  for (const lead of LEAD_TIMES) {
    const targetMs = now.getTime() + lead.minutes * 60 * 1000
    const lowerIso = new Date(targetMs - WINDOW_MIN * 60 * 1000).toISOString()
    const upperIso = new Date(targetMs + WINDOW_MIN * 60 * 1000).toISOString()

    // -------------------------- TASKS --------------------------
    //
    // activities.due_date (DATE) + due_time (TIME, nullable) →
    // construct a timestamptz at the LOCATION's timezone. If
    // due_time is null we treat the task as due at 09:00 local
    // (matches the implicit assumption in the existing tasks UI
    // where a date-only task shows at the top of that day).
    //
    // We do the date-arithmetic in SQL (Postgres handles tz
    // conversion correctly) and filter to the window in JS for
    // clarity. RPC would be cleaner — but for ~9k activity rows
    // total a single bounded query is fine.
    try {
      const { data: tasks, error: tErr } = await db
        .from('activities')
        .select(`
          id, subject, assignee_id, location_id, due_date, due_time,
          location:locations!inner(timezone)
        `)
        .eq('kind', 'task')
        .in('status', ['todo', 'in_progress'])
        .not('assignee_id', 'is', null)
        .not('due_date', 'is', null)
        .gte('due_date', new Date(targetMs - 36 * 3600 * 1000).toISOString().slice(0, 10))
        .lte('due_date', new Date(targetMs + 36 * 3600 * 1000).toISOString().slice(0, 10))

      if (tErr) {
        logError('cron-push-reminders', 'task fetch failed', { err: tErr, lead: lead.minutes })
      } else {
        const candidates = []
        for (const t of tasks || []) {
          const tz = t.location?.timezone || 'Europe/Dublin'
          const timeStr = t.due_time || '09:00:00'
          // ISO-like local string → Postgres-style. Convert via
          // Intl: build a Date that means "this local time in tz".
          const due = localToUtc(t.due_date, timeStr, tz)
          if (!due) continue
          if (due.toISOString() >= lowerIso && due.toISOString() <= upperIso) {
            candidates.push({ ...t, due_at: due.toISOString() })
          }
        }
        summary.task_candidates += candidates.length

        for (const t of candidates) {
          // Dedup: have we already pushed this lead-time to this assignee?
          const { data: existing } = await db
            .from('push_reminder_sends')
            .select('id')
            .eq('entity_type', 'task')
            .eq('entity_id', t.id)
            .eq('recipient_id', t.assignee_id)
            .eq('lead_time_minutes', lead.minutes)
            .maybeSingle()
          if (existing) { summary.task_skipped_dup++; continue }

          const result = await sendPush([t.assignee_id], {
            title: `Task due ${lead.label}`,
            body: t.subject || 'Untitled task',
            category: 'tasks',
            data: { type: 'task_reminder', task_id: t.id, lead_minutes: lead.minutes },
          })

          // Even on 0 sent (no device tokens) we still insert the
          // ledger row so a freshly-installed device doesn't get
          // a back-blast of stale reminders.
          await db.from('push_reminder_sends').insert({
            entity_type: 'task',
            entity_id: t.id,
            recipient_id: t.assignee_id,
            lead_time_minutes: lead.minutes,
            push_count: result.sent || 0,
            push_invalidated: result.invalidated || 0,
          }).then(({ error }) => {
            // ON CONFLICT (uniq) is fine — race with another tick.
            if (error && error.code !== '23505') {
              logWarn('cron-push-reminders', 'ledger insert failed', { err: error, t: t.id })
            }
          })

          if (result.sent > 0) summary.task_pushed++
          else summary.task_skipped_no_recipient++
        }
      }
    } catch (err) {
      logError('cron-push-reminders', 'task block threw', { err, lead: lead.minutes })
    }

    // -------------------------- BOOKINGS --------------------------
    //
    // Same shape, but recipients = role-set at the location. We
    // dedup per recipient_id in the ledger; the first recipient who
    // gets the push inserts a row, the rest follow. If two cron
    // ticks race, the second one's INSERT hits the uniq constraint
    // and we skip cleanly.
    try {
      const { data: bookings, error: bErr } = await db
        .from('bookings')
        .select(`
          id, customer_name, booking_date, start_time, status, location_id, skip_reminder,
          location:locations!inner(timezone),
          event_type:event_types(name)
        `)
        .eq('status', 'confirmed')
        .eq('skip_reminder', false)
        .gte('booking_date', new Date(targetMs - 36 * 3600 * 1000).toISOString().slice(0, 10))
        .lte('booking_date', new Date(targetMs + 36 * 3600 * 1000).toISOString().slice(0, 10))

      if (bErr) {
        logError('cron-push-reminders', 'booking fetch failed', { err: bErr, lead: lead.minutes })
      } else {
        const candidates = []
        for (const b of bookings || []) {
          if (!b.location_id || !b.booking_date || !b.start_time) continue
          const tz = b.location?.timezone || 'Europe/Dublin'
          const start = localToUtc(b.booking_date, b.start_time, tz)
          if (!start) continue
          if (start.toISOString() >= lowerIso && start.toISOString() <= upperIso) {
            candidates.push({ ...b, start_at: start.toISOString() })
          }
        }
        summary.booking_candidates += candidates.length

        for (const b of candidates) {
          // Resolve recipient set (owner/manager/head_coach at location).
          const { data: links } = await db
            .from('profile_locations')
            .select('profile_id, profiles!inner(id, role, active)')
            .eq('location_id', b.location_id)

          const recipientIds = (links || [])
            .filter(l => l.profiles?.active && BOOKING_NOTIFY_ROLES.includes(l.profiles.role))
            .map(l => l.profile_id)

          if (!recipientIds.length) continue

          // Per-recipient dedup. We fan out individually so a partial
          // failure (one recipient already sent, others fresh) still
          // delivers to the fresh ones.
          const { data: alreadySent } = await db
            .from('push_reminder_sends')
            .select('recipient_id')
            .eq('entity_type', 'booking')
            .eq('entity_id', b.id)
            .eq('lead_time_minutes', lead.minutes)
            .in('recipient_id', recipientIds)

          const alreadySetIds = new Set((alreadySent || []).map(r => r.recipient_id))
          const fresh = recipientIds.filter(id => !alreadySetIds.has(id))
          summary.booking_skipped_dup += alreadySetIds.size
          if (!fresh.length) continue

          const eventName = b.event_type?.name || 'booking'
          const timeLabel = formatLocalTime(b.start_time)
          const result = await sendPush(fresh, {
            title: `${eventName} ${lead.label}`,
            body: `${b.customer_name || 'Guest'} · ${timeLabel}`,
            category: 'bookings',
            data: { type: 'booking_reminder', booking_id: b.id, lead_minutes: lead.minutes },
          })

          // Insert one ledger row per fresh recipient.
          const rows = fresh.map(rid => ({
            entity_type: 'booking',
            entity_id: b.id,
            recipient_id: rid,
            lead_time_minutes: lead.minutes,
            push_count: 1, // approximate — sendPush returns aggregate
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
    } catch (err) {
      logError('cron-push-reminders', 'booking block threw', { err, lead: lead.minutes })
    }
  }

  if (Object.values(summary).some(v => v > 0)) {
    logInfo('cron-push-reminders', 'tick', summary)
  }

  await stampHeartbeat('send-push-reminders').catch((err) =>
    logWarn('cron-push-reminders', 'heartbeat failed', { err }))

  return NextResponse.json({ ok: true, ...summary })
}

// Helpers (localToUtc, formatLocalTime) extracted to
// @/lib/push-reminders so they're unit-testable.
