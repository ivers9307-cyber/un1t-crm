import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAgentFollowups } from '@/lib/agent/followups'

// AGENT-FOLLOWUP.1 — every 15 min (vercel.json): run Mia's proactive
// follow-up ladder for every location that enabled it. Stage 1 =
// in-window contextual nudge; stage 2 = one approved marketing
// template outside the window. Default OFF per location
// (settings.customer_agent.followups.enabled). Dublin daytime only —
// outside it the run is a cheap no-op (heartbeat still stamps).
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  let results = null
  try {
    results = await runAgentFollowups(db)
  } catch (e) {
    console.error('[radar-agent] followups tick failed:', e?.message || e)
    return NextResponse.json({ success: false, error: e?.message || 'tick failed' }, { status: 500 })
  }

  await stampHeartbeat('agent-followups')
  return NextResponse.json({ success: true, results })
}
