import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAgentReview } from '@/lib/agent/review'

// MIA-BOARD.4 — nightly at 03:00 (vercel.json): rubric-review yesterday's
// agent-touched conversations into agent_conversation_reviews (mig 569).
// Reruns are idempotent (unique (channel, conversation_id, review_date)).
// Mondays additionally push managers the 7-day flagged digest.
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  let results = null
  try {
    results = await runAgentReview(db)
  } catch (e) {
    console.error('[agent-review] tick failed:', e?.message || e)
    return NextResponse.json({ success: false, error: e?.message || 'tick failed' }, { status: 500 })
  }

  await stampHeartbeat('agent-review', results)
  return NextResponse.json({ success: true, results })
}
