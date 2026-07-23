// HYROX-TC.3 — nightly Vercel cron. Keeps ~2 weeks of sessions expanded
// ahead of "now" for every active Hyrox block (several Claude calls per
// block, hence the longer maxDuration). Auth: CRON_SECRET.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runExpandHyroxWeeks } from '@/lib/hyrox/expand-runner'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = await runExpandHyroxWeeks(db)
  await stampHeartbeat('expand-hyrox-weeks').catch((err) => logWarn('hyrox-expand', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, stats })
}
