// Vercel cron — close stale impersonation sessions (hourly).
//
// impersonation_log rows are closed by an explicit Stop or a re-target.
// Everything else (tab close, logout, cookie/SecureStore expiry) leaves
// the row open forever, which misrepresents a short debug session as
// "still ongoing" in the staff-visible access history. This reaper
// stamps a truthful upper-bound ended_at + auto_closed=true on any row
// open past the session max-age (src/lib/impersonation.js).
//
// Auth: same fail-closed CRON_SECRET pattern as the other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { closeStaleImpersonations } from '@/lib/impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const result = await closeStaleImpersonations(db)

  if (!result.ok) {
    console.warn(`[cron][close-stale-impersonations] ${result.error}`)
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }

  await stampHeartbeat('close-stale-impersonations')

  return NextResponse.json({
    success: true,
    stale: result.stale,
    closed: result.closed,
  })
}
