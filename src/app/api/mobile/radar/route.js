// GET /api/mobile/radar
//
// MOBILE-RADAR — read-only radar glance for the iOS app. Returns the
// churn + lead radar SUMMARIES only (headline counts + weekly trend +
// outreach effectiveness) — never the scored member/contact lists. The
// full triage dashboards (win-back, quarantine, cleanup) stay on web;
// this endpoint backs a read-only More-tab screen.
//
// Each section is gated on the caller's MOBILE permission
// (permissions.mobile.churn_radar / .lead_radar) — separate from the
// web sidebar permission so an operator can grant the phone glance
// without the desktop dashboard. A section the caller can't see comes
// back null; if they can see neither the route is 403.
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's
// Bearer fallback) + the x-active-location header from the mobile
// location switcher — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadRadar } from '@/lib/churn-radar-data'
import { loadFunnel } from '@/lib/lead-radar-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar + loadFunnel each page a few thousand rows and run the
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
  const canLead = hasMobilePermission(user, 'lead_radar')
  if (!canChurn && !canLead) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const data = { churn: null, lead: null }

  // Each radar is independent — one failing (or being unentitled)
  // must not sink the other. Errors surface as a per-section flag so
  // the screen can show a partial result rather than a blank error.
  if (canChurn) {
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
        recovery: summary.recovery || null,
        trend: summary.trend || null,
      }
    } catch (e) {
      data.churnError = e.message || 'fetch_failed'
    }
  }

  if (canLead) {
    try {
      const { summary } = await loadFunnel(db, locationId)
      data.lead = {
        funnelTotal: summary.funnelTotal || 0,
        attending: summary.funnel?.attending || 0,
        fresh: summary.funnel?.fresh || 0,
        cleanupTotal: summary.cleanupTotal || 0,
        conversion: summary.conversion || null,
        trend: summary.trend || null,
      }
    } catch (e) {
      data.leadError = e.message || 'fetch_failed'
    }
  }

  return NextResponse.json({ success: true, data })
}
