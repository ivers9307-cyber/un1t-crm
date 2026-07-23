// HYROX-TC.3 — Vercel cron, every 5 min. Reconciles each active Hyrox
// block's target TV(s) to the current live class's approved board.
// Auth: CRON_SECRET.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runPublishHyroxBoard } from '@/lib/hyrox/publish-runner'
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
  const stats = await runPublishHyroxBoard(db)
  await stampHeartbeat('publish-hyrox-board').catch((err) => logWarn('hyrox-publish', 'heartbeat failed', { err }))
  return NextResponse.json({ success: true, stats })
}
