// RADAR-DIGEST.1 / LEAD-DIGEST.1 — weekly radar email digest cron.
// OWNERDAILY.1 (19 Nov 2026): SENDS NOTHING. The owner's daily briefing
// (/api/cron/morning-briefing) replaced it; what follows is the history.
//
// Runs Monday 07:00 UTC — one hour after churn-radar-snapshot and
// lead-radar-snapshot, so the digest's trend trails include the
// snapshots just written. TZ.6: the schedule is hourly and each location acts
// at its Monday slot: Mon 07:00 UTC for a Europe/Dublin studio (as before),
// Mon 07:00 local for any other zone, once per local day
// (src/lib/cron-daily-slot.js). For every active location that has configured
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
import { gateDailySlot, slotTickStampable } from '@/lib/cron-daily-slot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // TZ.6 — which locations are at their Monday slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'churn-radar-digest', { module: 'churn-radar-digest' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return NextResponse.json({ success: !gate.faulted, emails_sent: 0, skipped_no_source: 0, perLocation: [], slot: gate.summary }, { status: gate.faulted ? 500 : 200 })
  }

  // OWNERDAILY.1 (19 Nov 2026) — the Monday digest no longer sends: its churn
  // and arrears figures are in the owner's daily briefing (morning-briefing).
  // The job keeps its slot and heartbeat until it is retired; the
  // churn-radar-snapshot job, not this one, writes the weekly snapshots.
  if (slotTickStampable(gate)) {
    await stampHeartbeat('churn-radar-digest').catch(() => {})
  }

  return NextResponse.json({ success: !gate.faulted, emails_sent: 0, merged_into: 'morning-briefing' }, { status: gate.faulted ? 500 : 200 })
}
