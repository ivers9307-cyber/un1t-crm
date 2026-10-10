// EVENT-WAITLIST.1 — the waitlist offer round (mig 713), every 10 minutes.
//
// For every event with people waiting: rows of a past event expire; an event
// that is published, open for registration and has room in any time offers
// everyone not offered in the last 24 h at once (email always, WhatsApp when
// the location has an APPROVED `event_waitlist_offer` template). The first to
// complete a booking gets the place: the register route is the arbiter.
// src/lib/event-waitlist.js runWaitlistOffers.
//
// Stamps its heartbeat on every completed run (a run with nothing to offer is
// healthy). Per-row send failures are counts in the outcome, never a missed
// stamp; only a run that could not read the list throws, returns 500 and
// leaves the row to go stale.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runWaitlistOffers } from '@/lib/event-waitlist'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  let data
  try {
    data = await runWaitlistOffers(db)
  } catch (e) {
    logError('cron.event-waitlist-offers', 'offer round failed', { err: e })
    return NextResponse.json({ success: false, error: 'Offer round failed' }, { status: 500 })
  }

  await stampHeartbeat('event-waitlist-offers', data)
  return NextResponse.json({ success: true, data })
}
