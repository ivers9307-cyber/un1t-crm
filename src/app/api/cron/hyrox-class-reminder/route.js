// HYROX-MOBILE (Batch D) — Vercel cron, every 5 min. Reminds the coach(es) on
// shift for each imminent HYROX class to review the workout ~30 min before it
// starts. Auth: CRON_SECRET.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runHyroxClassReminder } from '@/lib/hyrox/reminder-runner'
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
  const stats = await runHyroxClassReminder(db)
  await stampHeartbeat('hyrox-class-reminder').catch((err) => logWarn('hyrox-reminder', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, stats })
}
