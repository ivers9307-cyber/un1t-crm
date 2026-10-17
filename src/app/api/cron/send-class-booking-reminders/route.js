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
//
// C21 PUSHDONE.1b (F4) — the claim / send / release moved into sendNudgeOnce
// (src/lib/customer-nudge-claim.js), unchanged in behaviour, plus two silent
// failures made visible: a failed token read skipped its members as
// "unreachable" with nothing said (now counted in `reachability_failed` and
// logged; still retried next tick), and a failed claim INSERT read as
// "already reminded" (now logged; still retried next tick).
//
// UN1TBOOK.2 — Decision 1 (2026-10-17): the CRM never reminds a un1t.online
// booking or a booking at a un1t.online studio; the un1t.online app does. Two
// unconditional locks (no setting, capability or env flag reopens them): the
// read filters source_platform = CRM_CLASS_MESSAGING_PLATFORM, and a row at a
// un1t_online location is dropped and counted (`skipped_un1t_online`) before
// any reminder is chosen. A failed un1t_online locations read is logged and
// the tick goes on with the row filter alone (which, with mig 733's namespace
// CHECK, already excludes every un1t row): failing closed would cost
// Stillorgan its reminders.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendNudgeOnce, readReachableContacts, nudgeFailed } from '@/lib/customer-nudge-claim'
import { buildClassReminderPush } from '@/lib/customer-notifications'
import {
  resolveClassReminderLeadTimes, selectDueClassReminders, classTimeLabel,
} from '@/lib/class-reminders'
import { logInfo, logWarn, logError } from '@/lib/log'
import { zoneOfLocation } from '@/lib/location-time'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { CRM_CLASS_MESSAGING_PLATFORM } from '@/lib/class-bookings'
import { listLocationsByMembershipSource } from '@/lib/membership/source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
const WINDOW_MIN = 5       // fire up to 5 min EARLY (matches the cron tick)
// Fire up to 15 min LATE. A symmetric ±5 window meant two consecutive
// missed Vercel cron ticks silently lost the reminder forever (outside
// the window by the next tick, never in the nudge ledger). 15 min of
// late runway rides out up to three missed ticks — and a class reminder
// 15 min late still beats no reminder. The nudge dedup_key keeps sends
// at-most-once on normal operation.
const LATE_WINDOW_MIN = 15

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
    return NextResponse.json({ ok: true, due: 0, sent: 0, skipped_un1t_online: 0 })
  }

  // Decision 1 (2026-10-17): the CRM never sends class reminders or attendance
  // rewards for un1t.online; the un1t.online app does. Read once per tick.
  const { ids: un1tOnlineIds, error: un1tErr } = await listLocationsByMembershipSource(db, 'un1t_online')
  if (un1tErr) {
    logError('cron-class-reminders', 'un1t_online locations unreadable; reminding with the source_platform row filter alone', { err: un1tErr })
  }
  const un1tOnline = new Set(un1tOnlineIds || [])

  // Lower bound stays `now` on purpose: the late fire-window may reach
  // classes that already STARTED (lead - LATE_WINDOW_MIN < 0 for short
  // leads), but a "starts at 7:30pm" reminder after 7:30pm is noise —
  // so the class start itself caps the late catch-up.
  const fromIso = new Date(nowMs).toISOString()
  const untilIso = new Date(nowMs + (maxLead + WINDOW_MIN) * 60_000).toISOString()

  // Future, non-cancelled, contact-linked bookings in the window. Paginated —
  // the booking table can exceed Supabase's ~1000-row cap (1k-row invariant).
  const bookings = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('class_bookings')
      .select('id, contact_id, location_id, class_name, starts_at')
      // Decision 1 (2026-10-17): the CRM never sends class reminders or
      // attendance rewards for un1t.online; the un1t.online app does.
      .eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM)
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
    return NextResponse.json({ ok: true, due: 0, sent: 0, skipped_un1t_online: 0 })
  }

  // Decision 1 (2026-10-17): the CRM never sends class reminders or attendance
  // rewards for un1t.online; the un1t.online app does. A row at a un1t_online
  // studio is dropped whatever its source_platform says.
  const remindable = bookings.filter((b) => !un1tOnline.has(b.location_id))
  const skippedUn1tOnline = bookings.length - remindable.length

  // Which (booking, lead) pairs are due now — per the booking's own location
  // lead times.
  const due = []
  for (const b of remindable) {
    const loc = locById.get(b.location_id)
    const leadTimes = resolveClassReminderLeadTimes(loc?.notification_config)
    due.push(...selectDueClassReminders([b], nowMs, leadTimes, WINDOW_MIN, LATE_WINDOW_MIN))
  }
  if (due.length === 0) {
    await stampHeartbeat('send-class-booking-reminders').catch(() => {})
    return NextResponse.json({ ok: true, due: 0, sent: 0, skipped_un1t_online: skippedUn1tOnline })
  }

  // Keep only reachable members (have a push token). Filter BEFORE dedup —
  // burning a dedup row for an unreachable contact would block a later send
  // if they install the app before the class (mirrors notify-streak-at-risk).
  const { reachable, failed: reachabilityFailed } =
    await readReachableContacts(db, due.map((d) => d.contactId), 'cron-class-reminders')

  // Record (claim-before-send, idempotent) + push. The nudge insert is
  // the dedup claim; if the Expo send then FAILS outright (sent=0 with
  // failed>0 — pipeline down after retries, distinct from "no tokens":
  // reachability was already filtered above), we RELEASE the claim so
  // the next tick retries. Retry pressure is naturally capped by the
  // late fire-window — once past (start - lead + LATE_WINDOW_MIN) the
  // pair stops matching, so a permanently-failing send retries for at
  // most ~15 min.
  let sent = 0
  let sendFailed = 0
  for (const d of due) {
    if (!reachable.has(d.contactId)) continue
    const loc = locById.get(d.locationId)
    const { status } = await sendNudgeOnce(db, {
      contactId: d.contactId,
      type: 'class_reminder',
      dedupKey: `${d.bookingId}:${d.leadMinutes}`,
      payload: buildClassReminderPush({
        className: d.className,
        timeLabel: classTimeLabel(d.startsAt, zoneOfLocation(loc)),
        classBookingId: d.bookingId,
      }),
      module: 'cron-class-reminders',
    })
    if (status === 'sent') sent++
    else if (nudgeFailed(status)) sendFailed++
  }

  const summary = { bookings: bookings.length, due: due.length, sent, send_failed: sendFailed, reachability_failed: reachabilityFailed, skipped_un1t_online: skippedUn1tOnline }
  logInfo('cron-class-reminders', 'tick', summary)
  await stampHeartbeat('send-class-booking-reminders').catch((err) =>
    logWarn('cron-class-reminders', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, ...summary })
}
