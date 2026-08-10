// GET /api/campaigns/[id]/outcomes
//
// GAPS-P2 — what a campaign actually produced, not just who opened it.
//
// GUARD. assertLocationAccessOr404 below is the ONLY tenant boundary: this is
// a service-role route, so RLS does nothing here. It answers 404, never 403,
// so campaign ids cannot be enumerated by probing. Two IDORs shipped in this
// codebase in one week from exactly this guard being missing.
//
// AGGREGATION. The GROUP BY runs in Postgres via campaign_outcome_stats (mig
// 513). Pulling rows to count them here would hit the 1,000-row select cap and
// silently under-report — the defect class this whole programme has been
// removing. The route returns AGGREGATES ONLY: a per-contact outcome list is a
// different feature with different PII implications.
//
// WINDOW. ?window_days is a real parameter because the answer genuinely
// depends on it — two independent runs of this join disagreed (6 vs 5 event
// registrations for one campaign) purely on window choice. The route echoes
// the window it used so the UI can state it; a number without its window is
// not a measurement.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const DEFAULT_WINDOW_DAYS = 7
const MIN_WINDOW_DAYS = 1
const MAX_WINDOW_DAYS = 90

export function parseWindowDays(raw) {
  if (raw == null || raw === '') return DEFAULT_WINDOW_DAYS
  const n = Number(raw)
  if (!Number.isInteger(n)) return DEFAULT_WINDOW_DAYS
  if (n < MIN_WINDOW_DAYS || n > MAX_WINDOW_DAYS) return DEFAULT_WINDOW_DAYS
  return n
}

/**
 * Shape the two cohort rows into the comparison the UI leads with.
 *
 * The rates matter more than the counts, and that is the whole point of
 * returning the control: on a real campaign the clicked cohort registered for
 * events at 11.1% against 0% for non-openers (a genuine effect), while class
 * attendance was 11.1% against 9.2% (noise — members attend anyway). Reported
 * without the control, that second number reads as a result.
 */
export function buildOutcomeComparison(rows, windowDays) {
  const byCohort = Object.fromEntries((rows || []).map(r => [r.cohort, r]))
  const shape = (r) => {
    const contacts = Number(r?.contacts || 0)
    const rate = (n) => (contacts > 0 ? Number(n || 0) / contacts : null)
    return {
      contacts,
      event_registrations: Number(r?.event_registrations || 0),
      class_attendances: Number(r?.class_attendances || 0),
      purchases: Number(r?.purchases || 0),
      purchase_cents: Number(r?.purchase_cents || 0),
      rates: {
        event_registrations: rate(r?.event_registrations),
        class_attendances: rate(r?.class_attendances),
        purchases: rate(r?.purchases),
      },
    }
  }
  return {
    window_days: windowDays,
    clicked: shape(byCohort.clicked),
    not_opened: shape(byCohort.not_opened),
  }
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  const { data: campaign, error: campaignError } = await db
    .from('campaigns')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (campaignError || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard

  const windowDays = parseWindowDays(new URL(request.url).searchParams.get('window_days'))

  const { data, error } = await db.rpc('campaign_outcome_stats', {
    p_campaign_id: params.id,
    p_window_days: windowDays,
  })
  if (error) {
    console.error('[campaign outcomes] campaign_outcome_stats failed:', error.message)
    return NextResponse.json({ success: false, error: 'Could not load the outcome report' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: buildOutcomeComparison(data, windowDays) })
}
