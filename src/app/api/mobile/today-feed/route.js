// GET /api/mobile/today-feed
//
// MOBILE-TODAY-FEED — the "Needs attention" triage feed for the
// mobile PersonalDashboard. Exactly the same per-viewer feed the web
// /dashboard/today renders: fetchTodayFeed gates every source on the
// caller's WEB permission keys (approvals_inbox, issues_inbox,
// invoices_inbox, whatsapp, events/bookings, churn_radar, activities),
// so the phone shows precisely what the desktop would — no separate
// .mobile.* toggle by design. If an operator ever wants phone-only
// hiding, add a single `.mobile.today_feed` master toggle then; the
// per-row gating stays the web keys either way.
//
// No 403 for "no rows" — an empty feed is a legitimate all-clear /
// no-permissions state and the card renders nothing.
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's
// Bearer fallback) + the x-active-location header from the mobile
// location switcher — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { fetchTodayFeed } from '@/lib/today-feed-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// loadRadar pages a few thousand rows + the low-fill row makes a live
// Glofox call — same ceiling as /api/mobile/radar.
export const maxDuration = 60

// Signed in (the phone's Bearer token too) with an active studio; no
// permission key here — fetchTodayFeed gates every source itself.
export const GET = withAuth({ permission: null, location: true }, async ({ user, db, locationId }) => {
  const rows = await fetchTodayFeed(db, user, locationId)
  return NextResponse.json({ success: true, data: { rows } })
})
