// BRIEFING.1 — /api/cron/morning-briefing
//
// Mondays 06:00 UTC (07:00 Dublin in summer, 06:00 in winter). TZ.6: the
// schedule is hourly and each location acts at its Monday slot: Mon 06:00 UTC
// for a Europe/Dublin studio (as before), Mon 06:00 local for any other zone,
// once per local day (src/lib/cron-daily-slot.js); the date line is in the
// studio's zone. Per active location: builds the
// same "Needs attention" feed the Today dashboard shows (location
// level — approvals row omitted, see fetchLocationTodayFeed), renders
// it with buildMorningBriefingEmail, and emails the location's
// configured recipients.
//
// Recipients: reuses `locations.churn_digest_recipients` (the Monday
// radar digest list) — deliberately, so the briefing needs zero new
// config to start flowing and "who gets operational email" stays one
// list. Split into its own column + settings field later if the two
// audiences ever need to diverge. Empty list = briefing off for that
// location.
//
// Always sends when recipients are configured — an explicit "all
// clear" beats a silent gap (a missing email is indistinguishable
// from a broken cron). One bad location can't stall the sweep.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { fetchLocationTodayFeed } from '@/lib/today-feed-data'
import { fetchStudioPulse } from '@/lib/studio-pulse-data'
import { buildMorningBriefingEmail, shapePulseMetrics } from '@/lib/morning-briefing'
import { gateDailySlot, slotFor, slotTickStampable } from '@/lib/cron-daily-slot'
import { formatInZone } from '@/lib/location-time'
import { locationIdsWithoutCapability } from '@/lib/membership/locations-for-source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages a few thousand rows per location and the low-fill
// row makes a live Glofox call — same ceiling as the radar digest.
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const appUrl = getAppUrl()
  const nowMs = Date.now()

  // TZ.6 — which locations are at their Monday slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'morning-briefing', { nowMs, module: 'morning-briefing' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return NextResponse.json({ success: !gate.faulted, emails_sent: 0, perLocation: [], slot: gate.summary }, { status: gate.faulted ? 500 : 200 })
  }

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, churn_digest_recipients')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][morning-briefing] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  // UN1TCAP.1 — the pulse strip is membership numbers (members, at-risk,
  // trend): a studio whose source provides no membership data (none, or
  // un1t.online today) gets the briefing WITHOUT the strip, not a row of
  // Glofox-shaped zeros. Best-effort like the strip itself: an unreadable
  // capability list drops every strip this tick and still sends the briefing.
  const { ids: noMembershipData, error: capErr } = await locationIdsWithoutCapability(db, 'memberships')
  if (capErr) console.warn(`[cron][morning-briefing] membership capability unreadable; sending without the pulse strip: ${capErr.message || capErr}`)
  const pulseAllowed = (locationId) => !capErr && !noMembershipData.has(locationId)

  let emailsSent = 0
  const perLocation = []

  for (const loc of locations || []) {
    const slot = slotFor(gate.slots, loc.id)
    if (!slot) continue // TZ.6: not this location's slot
    const recipients = Array.isArray(loc.churn_digest_recipients)
      ? loc.churn_digest_recipients
      : []
    if (recipients.length === 0) continue // briefing off for this location

    try {
      // BRIEFING.2 — the pulse strip is best-effort (fetchStudioPulse
      // returns null on failure); the triage list is the core payload.
      const [rows, pulseBundle] = await Promise.all([
        // TZ.17 — the feed's "today" is this studio's day (the slot's zone).
        fetchLocationTodayFeed(db, loc.id, nowMs, { zone: slot.zone }),
        pulseAllowed(loc.id) ? fetchStudioPulse(db, loc.id) : null,
      ])
      const { subject, html } = buildMorningBriefingEmail(rows, {
        locationName: loc.name,
        dateLabel: formatInZone(nowMs, slot.zone, { weekday: 'long', day: 'numeric', month: 'long' }),
        appUrl,
        pulse: pulseBundle ? shapePulseMetrics(pulseBundle) : [],
      })
      for (const to of recipients) {
        await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'morning-briefing' })
        emailsSent++
      }
      perLocation.push({ location_id: loc.id, location_name: loc.name, rows: rows.length, recipients: recipients.length, ok: true })
    } catch (e) {
      // One bad location can't stall the rest of the sweep.
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: e.message })
    }
  }

  if (slotTickStampable(gate)) {
    await stampHeartbeat('morning-briefing').catch(() => {})
  }

  return NextResponse.json({ success: !gate.faulted, emails_sent: emailsSent, perLocation }, { status: gate.faulted ? 500 : 200 })
}
