// SONOS.10 — Vercel cron, every minute. Applies Sonos schedule windows
// exactly once each (volume + favourite on open, pause on close).
// runSonosReconcile is the tested body; this route is a thin
// CRON_SECRET-guarded wrapper, same skeleton as class-climate.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runSonosReconcile } from '@/lib/sonos/reconcile'
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
  const out = await runSonosReconcile(db)

  // CRONSTAMP.1 (audit 2026-11-15, item 12): stamp only a run that did not
  // fail (ok: false is a whole-run read failure). It used to stamp every
  // tick, so a sustained outage never went stale and nothing paged.
  if (out.ok !== false) {
    await stampHeartbeat('sonos-reconcile').catch((err) =>
      logWarn('cron-sonos-reconcile', 'heartbeat failed', { err }))
  }

  // `out.ok !== false`, not `out.ok === true`: the two `skipped` results
  // carry no `ok` key and a dormant deploy must not page. A real crash
  // throws out of runSonosReconcile and 500s here, which IS worth paging on.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
