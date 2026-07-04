// src/app/api/cron/receipt-coverage-weekly/route.js
//
// RCOV.P0 — Friday 08:00 Europe/Dublin. vercel.json fires this at
// 07:00 AND 08:00 UTC on Fridays (DST straddle); the Dublin-hour gate
// makes exactly one firing run, and the alreadyRanToday check absorbs
// retries/manual re-fires. Env RECEIPT_COVERAGE_REPORT_TO is REQUIRED
// — checked up-front so a misconfig fails loudly, before any pulls.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinNowMinutes, dublinDayStr, dublinTodayStr } from '@/lib/dublin-time'
import { runCoveragePull } from '@/lib/recon/pull'
import { renderCoverageReportHtml, sendCoverageReport, shouldRunFridayCron, reportRecipients } from '@/lib/recon/report-email'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  reportRecipients() // throws if env missing — fail loudly before any work

  const db = createServerClient()

  const { data: lastCron } = await db
    .from('recon_runs')
    .select('started_at')
    .eq('trigger', 'cron')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const alreadyRanToday = !!lastCron && dublinDayStr(lastCron.started_at) === dublinTodayStr()

  if (!shouldRunFridayCron({ dublinMinutes: dublinNowMinutes(), alreadyRanToday })) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const { data: conns, error: connErr } = await db
    .from('xero_connections')
    .select('location_id, location:location_id(id, name)')
  if (connErr) {
    console.error('[receipt-coverage-weekly] connections load failed', connErr)
    return NextResponse.json({ success: false, error: connErr.message }, { status: 500 })
  }

  const sections = []
  const errors = []
  for (const conn of conns || []) {
    const locationName = conn.location?.name || conn.location_id
    try {
      const summary = await runCoveragePull(db, conn.location_id, { trigger: 'cron' })
      const { data: uncovered } = await db
        .from('recon_bank_lines')
        .select('line_date, description, reference, amount')
        .eq('location_id', conn.location_id)
        .eq('status', 'uncovered')
        .order('line_date', { ascending: true })
        .limit(200)
      const agg = summary.accounts.reduce(
        (a, s) => ({ pulled: a.pulled + s.pulled, new: a.new + s.new, covered: a.covered + s.covered }),
        { pulled: 0, new: 0, covered: 0 }
      )
      sections.push({ locationName, stats: agg, anomalies: summary.anomalies, uncovered: uncovered || [] })
    } catch (e) {
      console.error('[receipt-coverage-weekly] pull failed', locationName, e)
      errors.push({ locationName, error: String(e?.message || e) })
    }
  }

  const dateStr = dublinTodayStr()
  const html = renderCoverageReportHtml({ appUrl: getAppUrl(), dateStr, sections, errors })
  let emailError = null
  try {
    await sendCoverageReport({ html, dateStr })
  } catch (e) {
    console.error('[receipt-coverage-weekly] report send failed', e)
    emailError = String(e?.message || e)
  }

  const anomalyCount = sections.reduce((n, s) => n + (s.anomalies?.length || 0), 0)
  if (errors.length === 0 && !emailError && anomalyCount === 0) {
    await stampHeartbeat('receipt-coverage-weekly').catch(() => {})
  }

  return NextResponse.json({
    success: errors.length === 0 && !emailError,
    data: { locations: sections.length, anomalies: anomalyCount, errors, emailError },
  })
}
