// P2-7 (Part A) — Vercel cron, every 5 min.
//
// Pushes a pre-class reminder to members with an upcoming booked Glofox class,
// at the per-location lead time (default 30 min before; configurable via
// locations.notification_config.categories.class_reminder.lead_times_minutes).
// Idempotent per (member, booking, lead-time) via customer_engagement_nudges
// (dedup_key '<class_booking_id>:<lead>'). Reachable members only (a registered
// champ_push_token = opted in). A class reminder is transactional — the member
// booked the class — so it doesn't gate on marketing consent.
//
// class_bookings.starts_at is a UTC timestamptz (Glofox-fed), so the window
// logic compares UTC instants directly; only the time label uses the location tz.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
import { buildClassReminderPush } from '@/lib/customer-notifications'
import {
  resolveClassReminderLeadTimes, selectDueClassReminders, classTimeLabel,
} from '@/lib/class-reminders'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
const WINDOW_MIN = 5

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const nowMs = Date.now()

  // Locations + their reminder config (timezone for the label, lead times).
  const { data: locs } = await db
    .from('locations')
    .select('id, timezone, notification_config')
  const locById = new Map((locs || []).map((l) => [l.id, l]))

  // Widest lead across all locations bounds the fetch window.
  let maxLead = 0
  for (const l of locs || []) {
    for (const lt of resolveClassReminderLeadTimes(l.notification_config)) {
      if (lt > maxLead) maxLead = lt
    }
  }
  if (maxLead === 0) {
    await stampHeartbeat('send-class-booking-reminders').catch(() => {})
    return NextResponse.json({ ok: true, due: 0, sent: 0 })
  }

  const fromIso = new Date(nowMs).toISOString()
  const untilIso = new Date(nowMs + (maxLead + WINDOW_MIN) * 60_000).toISOString()

  // Future, non-cancelled, contact-linked bookings in the window. Paginated —
  // the booking table can exceed Supabase's ~1000-row cap (1k-row invariant).
  const bookings = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('class_bookings')
      .select('id, contact_id, location_id, class_name, starts_at')
      .not('contact_id', 'is', null)
      .not('status', 'eq', 'CANCELLED')
      .gte('starts_at', fromIso)
      .lte('starts_at', untilIso)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { logWarn('cron-class-reminders', 'booking query failed', { err: error }); break }
    bookings.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  if (bookings.length === 0) {
    await stampHeartbeat('send-class-booking-reminders').catch(() => {})
    return NextResponse.json({ ok: true, due: 0, sent: 0 })
  }

  // Which (booking, lead) pairs are due now — per the booking's own location
  // lead times.
  const due = []
  for (const b of bookings) {
    const loc = locById.get(b.location_id)
    const leadTimes = resolveClassReminderLeadTimes(loc?.notification_config)
    due.push(...selectDueClassReminders([b], nowMs, leadTimes, WINDOW_MIN))
  }
  if (due.length === 0) {
    await stampHeartbeat('send-class-booking-reminders').catch(() => {})
    return NextResponse.json({ ok: true, due: 0, sent: 0 })
  }

  // Keep only reachable members (have a push token). Filter BEFORE dedup —
  // burning a dedup row for an unreachable contact would block a later send
  // if they install the app before the class (mirrors notify-streak-at-risk).
  const candidateIds = [...new Set(due.map((d) => d.contactId))]
  const reachable = new Set()
  for (let i = 0; i < candidateIds.length; i += 200) {
    const chunk = candidateIds.slice(i, i + 200)
    const { data: toks } = await db.from('champ_push_tokens').select('contact_id').in('contact_id', chunk)
    for (const t of toks || []) reachable.add(t.contact_id)
  }

  // Record (idempotent) + push.
  let sent = 0
  for (const d of due) {
    if (!reachable.has(d.contactId)) continue
    const dedupKey = `${d.bookingId}:${d.leadMinutes}`
    const { data: ins, error: insErr } = await db
      .from('customer_engagement_nudges')
      .insert({ contact_id: d.contactId, type: 'class_reminder', dedup_key: dedupKey })
      .select('id')
    if (insErr || !ins || !ins.length) continue // already reminded for this booking+lead, or error
    const loc = locById.get(d.locationId)
    const payload = buildClassReminderPush({
      className: d.className,
      timeLabel: classTimeLabel(d.startsAt, loc?.timezone || 'Europe/Dublin'),
      classBookingId: d.bookingId,
    })
    try {
      await sendCustomerPush(db, d.contactId, payload)
      sent++
    } catch (err) {
      logWarn('cron-class-reminders', 'push threw', { err, contactId: d.contactId })
    }
  }

  logInfo('cron-class-reminders', 'tick', { bookings: bookings.length, due: due.length, sent })
  await stampHeartbeat('send-class-booking-reminders').catch((err) =>
    logWarn('cron-class-reminders', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, bookings: bookings.length, due: due.length, sent })
}
