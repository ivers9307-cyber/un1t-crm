// BATHROOM-CLIMATE.1 — Vercel cron, every 5 min. Turns the configured
// bathroom AC on for any class whose post-start window (start + delay)
// is open, for every location with the bathroom_climate automation
// enabled. The OFF is handled by the existing ac-auto-off cron (we write
// a session with a schedule-anchored auto_off_at). Idempotent via
// automation_fire_log.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runBathroomClimate } from '@/lib/bathroom-climate-runner'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runBathroomClimate(db, {})

  await stampHeartbeat('bathroom-climate').catch((err) =>
    logWarn('cron-bathroom-climate', 'heartbeat failed', { err }))
  return NextResponse.json({ success: out.ok !== false, ...out })
}
