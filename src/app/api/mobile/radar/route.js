// GET /api/mobile/radar
//
// MOBILE-RADAR — read-only radar glance for the iOS app. Returns the
// churn radar SUMMARY only (headline counts + weekly trend +
// outreach effectiveness) — never the scored member/contact lists. The
// full triage dashboards (win-back, quarantine, cleanup) stay on web;
// this endpoint backs a read-only More-tab screen.
//
// Gated on the caller's MOBILE permission (permissions.mobile.churn_radar)
// — separate from the web sidebar permission so an operator can grant the
// phone glance without the desktop dashboard.
//
// CONTACTLOG.2 — the Lead Radar is retired (the board's "Not contacted"
// filter replaces it). `lead` stays in the answer, always null, so a phone
// on an older bundle hides the section instead of breaking.
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's
// Bearer fallback) + the x-active-location header from the mobile
// location switcher — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadRadar } from '@/lib/churn-radar-data'
import { radarAvailability } from '@/lib/radar-availability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages a few thousand rows and run the
// scoring. Single-tenant in practice; 60s leaves ample headroom.
export const maxDuration = 60

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const canChurn = hasMobilePermission(user, 'churn_radar')
  if (!canChurn) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const data = { churn: null, lead: null }

  // UN1TRADAR.1 — a source without membership data: both sections stay null
  // (the screen already hides a null section). Asked once; an unreadable
  // source is a per-section error, as a failed load is.
  let avail
  try {
    avail = await radarAvailability(db, locationId, { module: 'mobile-radar' })
  } catch (e) {
    const err = e.message || 'fetch_failed'
    data.churnError = err
    return NextResponse.json({ success: true, data })
  }
  if (!avail.available) return NextResponse.json({ success: true, data })

  // A failed load surfaces as a per-section flag, as before.
  {
    try {
      const { summary } = await loadRadar(db, locationId)
      data.churn = {
        activeBase: summary.activeBase || 0,
        atRisk: summary.atRisk || 0,
        highRisk: summary.highRisk || 0,
        overdue: summary.overdue || 0,
        paused: summary.paused || 0,
        quarantine: summary.quarantine || 0,
        revenueAtRiskCents: summary.revenueAtRiskCents || 0,
        overdueValueCents: summary.overdueValueCents || 0,
        // UN1TRADAR.2 — only when the total includes an estimate
        ...(summary.overdueValueEstimated === true ? { overdueValueEstimated: true } : {}),
        recovery: summary.recovery || null,
        trend: summary.trend || null,
      }
    } catch (e) {
      data.churnError = e.message || 'fetch_failed'
    }
  }

  return NextResponse.json({ success: true, data })
}
