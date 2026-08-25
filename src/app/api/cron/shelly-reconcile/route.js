// SHELLY.9 — Vercel cron, every minute. Reads every Shelly-connected
// location's device state, rolls energy, and applies schedule windows and
// manual overrides exactly once each. runShellyReconcile is the tested body;
// this is a thin CRON_SECRET-guarded wrapper, same skeleton as sonos-reconcile.
//
// Dormant by construction: zero shelly_connections rows → { ok:true,
// locations:0 } and the heartbeat still stamps, so a deploy ahead of the first
// connection never pages. A tick that did NOT complete does not stamp — see
// the heartbeat comment in GET.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runShellyReconcile } from '@/lib/shelly/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Worst case per account ≈ 7 paced calls × (1 s gap + 8 s timeout); accounts
// run 4 in parallel and the run itself stops issuing calls after 90 s.
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runShellyReconcile(db)

  // STAMPED ONLY ON A COMPLETED TICK. `out.ok !== false` is the same test the
  // response uses: a dormant result (no `ok` key) stamps, an explicit
  // `ok: false` — the connection load failing, or a clock we cannot trust —
  // does not. A single blip is absorbed by the heartbeat's 900 s grace, so one
  // missed stamp pages nobody; a sustained connection-load failure or a bad
  // clock outlives the grace and pages, which is exactly the tick that should.
  // Stamping regardless would keep the row fresh through an outage the health
  // check exists to catch.
  //
  // Counters ride into cron_heartbeats.last_outcome so ops can tell "ran,
  // 0 connections" from "ran, 12 failed" without opening the logs. Safe to
  // store verbatim: every key runShellyReconcile returns is a number, plus
  // `ok` and the `bad_clock` reason — the host, the auth key and the vendor
  // error text are redacted into the logs and never into the result.
  if (out.ok !== false) {
    await stampHeartbeat('shelly-reconcile', out).catch((err) =>
      logWarn('cron-shelly-reconcile', 'heartbeat failed', { err }))
  }

  // `out.ok !== false`, not `out.ok === true`: a dormant deploy must not page.
  // Both false results SHOULD — a sweep that cannot read its own configuration,
  // or cannot trust its clock, is not a quiet minute.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
