// src/app/api/cron/ad-report-email/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadAdsDashboard } from '@/lib/ads/read'
import { buildAdReportEmail } from '@/lib/ads/report'
import { sendEmail } from '@/lib/postmark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const { data: locations } = await db.from('locations').select('id, name, settings').eq('active', true)
  const results = []
  for (const loc of locations || []) {
    const recipients = loc.settings?.ads?.report_recipients || []
    const { data: hasAccount } = await db.from('ad_accounts').select('id').eq('location_id', loc.id).eq('is_active', true).limit(1).maybeSingle()
    if (!recipients.length || !hasAccount) continue
    try {
      const dash = await loadAdsDashboard(db, loc.id, 1) // yesterday
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date())
      const { subject, html } = buildAdReportEmail({ locationName: loc.name, date, kpis: dash.kpis, perAd: dash.perAd })
      for (const to of recipients) await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'ad-report' })
      results.push({ loc: loc.id, sent: recipients.length })
    } catch (e) { results.push({ loc: loc.id, error: e.message }) }
  }
  await stampHeartbeat('ad-report-email').catch(() => {})
  return NextResponse.json({ success: true, results })
}
