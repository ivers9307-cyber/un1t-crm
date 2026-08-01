// HOMEYD.4 — Vercel cron, every minute. Reconciles Homey Pro device state
// against the desired-state engine (schedule + override) and fires any
// on/off commands needed to close the gap; also ingests the device state
// report so last_seen_at/last_state stay live for the dashboard dots.
// runHomeyReconcile (src/lib/homey/reconcile.js) is the tested body — this
// route is a thin CRON_SECRET-guarded wrapper, same skeleton as
// class-climate.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runHomeyReconcile } from '@/lib/homey/reconcile'
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
  const out = await runHomeyReconcile(db)

  await stampHeartbeat('homey-reconcile').catch((err) =>
    logWarn('cron-homey-reconcile', 'heartbeat failed', { err }))
  // Deliberately `out.ok !== false`, not `out.ok === true`: the two
  // `skipped` results (unconfigured/misconfigured) carry no `ok` key,
  // `homeyDown` returns `ok: true`, and a transient DB blip inside
  // runHomeyReconcile returns `{ ok: false }` for THIS tick only — none of
  // those are a dead cron, so the heartbeat still stamps above and the
  // route still reports `success` unless the body explicitly said `ok:
  // false`. A real crash would throw out of runHomeyReconcile and 500 here
  // instead, which IS worth paging on.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
