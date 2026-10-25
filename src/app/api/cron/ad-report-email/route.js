// src/app/api/cron/ad-report-email/route.js
//
// TZ.6 — hourly; each location acts at its daily slot: 07:00 UTC for a
// Europe/Dublin studio (as before), 07:00 local for any other zone, once per
// local day (src/lib/cron-daily-slot.js). The date in the email is the
// studio's today. (Which day the KPIs cover is loadAdsDashboard's: TZ.11c.)
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadAdsDashboard } from '@/lib/ads/read'
import { buildAdReportEmail } from '@/lib/ads/report'
import { sendEmail } from '@/lib/postmark'
import { gateDailySlot, slotFor, slotTickStampable } from '@/lib/cron-daily-slot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'ad-report-email', { module: 'ad-report-email' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return NextResponse.json({ success: !gate.faulted, results: [], slot: gate.summary }, { status: gate.faulted ? 500 : 200 })
  }
  const { data: locations } = await db.from('locations').select('id, name, settings, timezone').eq('active', true)
  const results = []
  for (const loc of locations || []) {
    const slot = slotFor(gate.slots, loc.id)
    if (!slot) continue // TZ.6: not this location's slot
    const recipients = loc.settings?.ads?.report_recipients || []
    const { data: hasAccount } = await db.from('ad_accounts').select('id').eq('location_id', loc.id).eq('is_active', true).limit(1).maybeSingle()
    if (!recipients.length || !hasAccount) continue
    try {
      const dash = await loadAdsDashboard(db, loc.id, 1) // yesterday
      const date = slot.day // en-CA 'YYYY-MM-DD' in the studio's zone, as the Dublin one was
      const { subject, html } = buildAdReportEmail({ locationName: loc.name, date, kpis: dash.kpis, perAd: dash.perAd })
      for (const to of recipients) await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'ad-report' })
      results.push({ loc: loc.id, sent: recipients.length })
    } catch (e) { results.push({ loc: loc.id, error: e.message }) }
  }
  if (slotTickStampable(gate)) {
    await stampHeartbeat('ad-report-email').catch(() => {})
  }
  return NextResponse.json({ success: !gate.faulted, results }, { status: gate.faulted ? 500 : 200 })
}
