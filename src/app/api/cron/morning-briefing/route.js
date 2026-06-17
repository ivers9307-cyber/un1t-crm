// BRIEFING.1 — /api/cron/morning-briefing
//
// Mondays 06:00 UTC (07:00 Dublin in summer, 06:00 in winter — Vercel
// cron is UTC-only; see vercel.json). Per active location: builds the
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

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, churn_digest_recipients')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][morning-briefing] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const dateLabel = new Intl.DateTimeFormat('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Dublin',
  }).format(new Date())

  let emailsSent = 0
  const perLocation = []

  for (const loc of locations || []) {
    const recipients = Array.isArray(loc.churn_digest_recipients)
      ? loc.churn_digest_recipients
      : []
    if (recipients.length === 0) continue // briefing off for this location

    try {
      // BRIEFING.2 — the pulse strip is best-effort (fetchStudioPulse
      // returns null on failure); the triage list is the core payload.
      const [rows, pulseBundle] = await Promise.all([
        fetchLocationTodayFeed(db, loc.id),
        fetchStudioPulse(db, loc.id),
      ])
      const { subject, html } = buildMorningBriefingEmail(rows, {
        locationName: loc.name,
        dateLabel,
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

  await stampHeartbeat('morning-briefing').catch(() => {})

  return NextResponse.json({ success: true, emails_sent: emailsSent, perLocation })
}
