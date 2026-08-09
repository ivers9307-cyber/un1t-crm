// COMMSFIX.F.3 (mig 510) — per-link click report for a campaign.
//
// Answers "which link did people actually click?", the question the old
// clicked_links jsonb array could not: "which link won" is a GROUP BY url, and
// you cannot group across 19,140 jsonb arrays.
//
// Two properties are load-bearing here.
//
// ACCESS. This route uses the service-role client, which bypasses RLS — the
// assertLocationAccessOr404 below is the ONLY tenant boundary. It answers 404,
// never 403, so campaign ids cannot be enumerated by probing. The two IDORs
// this codebase shipped recently (template editor #1307, event types #1311)
// were both exactly this guard, missing.
//
// AGGREGATION. The GROUP BY runs in Postgres via campaign_link_click_stats.
// Pulling rows to group them here would hit the 1,000-row select cap — which
// returns a short list with no error, so the report would simply be wrong and
// look fine. The RPC is service_role-only for the same reason this route needs
// a guard: it takes a bare campaign uuid and does no location check of its own.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
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

  const { data, error } = await db.rpc('campaign_link_click_stats', { p_campaign_id: params.id })
  if (error) {
    console.error('[campaign links] campaign_link_click_stats failed:', error.message)
    return NextResponse.json({ success: false, error: 'Could not load the link report' }, { status: 500 })
  }

  // The RPC already orders by unique_clickers desc; re-sorting here keeps the
  // contract owned by the route rather than by whatever the function body last
  // said. Counts are coerced because a bigint arriving as a string would turn
  // the UI's share-bar maths into NaN silently.
  const rows = (data || [])
    .map((r) => ({
      url: r.url,
      clicks: Number(r.clicks) || 0,
      unique_clickers: Number(r.unique_clickers) || 0,
    }))
    .sort((a, b) => b.unique_clickers - a.unique_clickers || b.clicks - a.clicks)

  return NextResponse.json({ success: true, data: rows })
}
