// RADAR-DIGEST.1 / LEAD-DIGEST.1 — weekly radar email digest cron.
//
// Runs Monday 07:00 UTC — one hour after churn-radar-snapshot and
// lead-radar-snapshot, so the digest's trend trails include the
// snapshots just written. For every active location that has configured
// digest recipients, it computes the live churn + lead summaries, pulls
// the recent snapshot history for each, composes one combined digest
// email and sends it to each recipient.
//
// LEAD-DIGEST.1 folded the Lead Radar funnel into this same email — the
// lead block is best-effort, so a lead-radar failure degrades the email
// to churn-only rather than blocking the send.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { sendEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { loadRadar } from '@/lib/churn-radar-data'
import { loadFunnel } from '@/lib/lead-radar-data'
import { buildDigestEmail } from '@/lib/churn-radar-digest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, churn_digest_recipients')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][churn-radar-digest] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const radarUrl = `${getAppUrl()}/churn-radar`
  const leadRadarUrl = `${getAppUrl()}/lead-radar`
  let emailsSent = 0
  const perLocation = []

  for (const loc of locations || []) {
    const recipients = Array.isArray(loc.churn_digest_recipients)
      ? loc.churn_digest_recipients
      : []
    if (recipients.length === 0) continue  // digest off for this location

    try {
      const { summary } = await loadRadar(db, loc.id)

      // Recent snapshot history for the "recent weeks" trail — newest
      // first off the index, reversed to oldest-first for rendering.
      const { data: history } = await db
        .from('churn_radar_snapshots')
        .select('captured_at, active_base, at_risk, high_risk, overdue, paused, quarantine, revenue_at_risk_cents, overdue_value_cents')
        .eq('location_id', loc.id)
        .order('captured_at', { ascending: false })
        .limit(5)
      const ordered = (history || []).slice().reverse()

      // LEAD-DIGEST.1 — lead funnel block. Best-effort: a lead-radar
      // failure must not block the churn digest, so it is caught here
      // and the email degrades to churn-only.
      let lead = null
      try {
        const { summary: leadSummary } = await loadFunnel(db, loc.id)
        const { data: leadHistory } = await db
          .from('lead_radar_snapshots')
          .select('captured_at, funnel_total, attending, fresh, cleanup_total')
          .eq('location_id', loc.id)
          .order('captured_at', { ascending: false })
          .limit(5)
        lead = {
          summary: leadSummary,
          history: (leadHistory || []).slice().reverse(),
        }
      } catch (leadErr) {
        console.warn(`[cron][churn-radar-digest] lead block failed for ${loc.id}: ${leadErr.message}`)
      }

      const { subject, html } = buildDigestEmail(summary, ordered, {
        locationName: loc.name,
        radarUrl,
        leadRadarUrl,
        lead,
      })

      for (const to of recipients) {
        await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'churn-radar-digest' })
        emailsSent++
      }
      perLocation.push({ location_id: loc.id, location_name: loc.name, recipients: recipients.length, lead: !!lead, ok: true })
    } catch (e) {
      // One bad location can't stall the rest of the sweep.
      perLocation.push({ location_id: loc.id, location_name: loc.name, ok: false, error: e.message })
    }
  }

  await stampHeartbeat('churn-radar-digest').catch(() => {})

  return NextResponse.json({ success: true, emails_sent: emailsSent, perLocation })
}
