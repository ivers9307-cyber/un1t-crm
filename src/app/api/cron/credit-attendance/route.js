// INCLUSION-CORE T4 — Vercel cron, daily 03:00 UTC.
//
// Auto-credits a flat "participation" heart_rate_sessions row (points + class
// count) to every member marked ATTENDED for a completed Glofox class who
// doesn't already have a session for that class. No-device attendees still earn
// points and compete; everything downstream (challenges/streaks/progress/tiers)
// is source-agnostic, so creating the session row is all that's needed —
// finalizeSessionRewards runs the usual reward cascade on each new session.
//
// Idempotent: a (contact, class) pair that already has ANY session (an HR
// session for device users, OR a participation session from a previous run) is
// skipped. The dedupe decision lives in the pure helpers in
// src/lib/credit-attendance.js (unit-tested).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createParticipationSession, finalizeSessionRewards } from '@/lib/live-class'
import { resolveScoringConfig, resolveMaxHr } from '@/lib/heart-rate'
import { dedupeKey, filterUncredited } from '@/lib/credit-attendance'
import { DEFAULT_CLASS_MINUTES } from '@/lib/class-occurrences'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
// A class is "completed" once it started at least this long ago — gives the
// Glofox attendance sync time to land the attended flag before we credit.
const COMPLETED_GRACE_MS = 60 * 60 * 1000 // 1h
// Backfill guard: only credit recently-completed classes. Prevents the first run from sweeping months of history (stale pushes + current-month mis-banking + timeout). 3 days covers daily cadence + attended-flag sync latency + a missed cron day. Tunable.
const LOOKBACK_DAYS = 3

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const nowMs = Date.now()
  const completedBeforeIso = new Date(nowMs - COMPLETED_GRACE_MS).toISOString()

  // Locations → settings, for resolveScoringConfig lookups.
  const locationMap = new Map()
  {
    const { data: locations, error } = await db.from('locations').select('id, settings')
    if (error) {
      logWarn('cron-credit-attendance', 'locations load failed', { err: error })
      return NextResponse.json({ success: false, error: 'locations load failed' }, { status: 500 })
    }
    for (const l of locations || []) locationMap.set(l.id, l)
  }

  let scanned = 0
  let credited = 0

  // Paginate attended, contact-linked, completed bookings (oldest first).
  for (let from = 0; ; from += PAGE) {
    const { data: bookings, error } = await db
      .from('class_bookings')
      .select('id, location_id, glofox_event_id, contact_id, class_name, starts_at')
      .eq('attended', true)
      .not('contact_id', 'is', null)
      .gte('starts_at', new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString())
      .lt('starts_at', completedBeforeIso)
      .order('starts_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      logWarn('cron-credit-attendance', 'bookings query failed', { err: error, from })
      break
    }
    if (!bookings || bookings.length === 0) break
    scanned += bookings.length

    // Batch-load existing sessions for this page's (contact, event) pairs and
    // build the set of keys that already have ANY session (HR or participation).
    // No N+1 — one query for the whole page.
    const pageContactIds = [...new Set(bookings.map((b) => b.contact_id).filter(Boolean))]
    const pageEventIds = [...new Set(bookings.map((b) => b.glofox_event_id).filter(Boolean))]
    const existingKeys = new Set()
    if (pageContactIds.length && pageEventIds.length) {
      // .in × .in returns a cross-product superset; filterUncredited narrows it back to exact (contact, event) keys.
      const { data: sessions, error: sErr } = await db
        .from('heart_rate_sessions')
        .select('contact_id, glofox_event_id')
        .in('contact_id', pageContactIds)
        .in('glofox_event_id', pageEventIds)
      if (sErr) {
        logWarn('cron-credit-attendance', 'existing sessions query failed', { err: sErr, from })
      } else {
        for (const s of sessions || []) {
          const key = dedupeKey(s)
          if (key) existingKeys.add(key)
        }
      }
    }

    // Decide which bookings still need a credit (pure + tested).
    const toCredit = filterUncredited(bookings, existingKeys)
    if (toCredit.length === 0) {
      if (bookings.length < PAGE) break
      continue
    }

    // Batch-load this page's contacts for resolveMaxHr.
    const creditContactIds = [...new Set(toCredit.map((b) => b.contact_id))]
    const contactById = new Map()
    for (let i = 0; i < creditContactIds.length; i += 200) {
      const chunk = creditContactIds.slice(i, i + 200)
      const { data: contacts, error: cErr } = await db
        .from('contacts')
        .select('id, max_hr_override, dob')
        .in('id', chunk)
      if (cErr) {
        logWarn('cron-credit-attendance', 'contacts load failed', { err: cErr })
        continue
      }
      for (const c of contacts || []) contactById.set(c.id, c)
    }

    // Batch-load class end times for this page's events (for ended_at).
    const endByEventId = new Map()
    for (let i = 0; i < pageEventIds.length; i += 200) {
      const chunk = pageEventIds.slice(i, i + 200)
      const { data: occs, error: oErr } = await db
        .from('class_occurrences')
        .select('glofox_event_id, ends_at')
        .in('glofox_event_id', chunk)
        .is('cancelled_at', null)
      if (oErr) {
        logWarn('cron-credit-attendance', 'occurrences load failed', { err: oErr })
        continue
      }
      for (const o of occs || []) {
        if (o.ends_at && !endByEventId.has(o.glofox_event_id)) endByEventId.set(o.glofox_event_id, o.ends_at)
      }
    }

    for (const booking of toCredit) {
      // Best-effort per booking — log + continue so one bad row can't abort the run.
      try {
        const location = locationMap.get(booking.location_id)
        const { participationPoints } = resolveScoringConfig(location)
        const contact = contactById.get(booking.contact_id)
        const maxHr = resolveMaxHr(contact)

        // Class end time from the schedule spine; else starts_at + 60min.
        let endedAtIso = endByEventId.get(booking.glofox_event_id) || null
        if (!endedAtIso) {
          const startMs = new Date(booking.starts_at).getTime()
          endedAtIso = Number.isFinite(startMs)
            ? new Date(startMs + DEFAULT_CLASS_MINUTES * 60_000).toISOString()
            : new Date(nowMs).toISOString()
        }

        const id = await createParticipationSession(db, {
          contactId: booking.contact_id,
          locationId: booking.location_id,
          glofoxEventId: booking.glofox_event_id,
          className: booking.class_name,
          startedAtIso: booking.starts_at,
          endedAtIso,
          participationPoints,
          maxHr,
        })
        if (!id) continue // insert failed (already logged inside the helper)

        await finalizeSessionRewards(db, id, { nowMs: Date.now() })
        credited++
      } catch (err) {
        logWarn('cron-credit-attendance', 'credit threw', {
          err, bookingId: booking.id, contactId: booking.contact_id, glofoxEventId: booking.glofox_event_id,
        })
      }
    }

    if (bookings.length < PAGE) break
  }

  logInfo('cron-credit-attendance', 'tick', { scanned, credited })
  await stampHeartbeat('credit-attendance').catch((err) =>
    logWarn('cron-credit-attendance', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, credited, scanned })
}
