// SHELLY.9 — Vercel cron, every minute. Reads every Shelly-connected
// location's device state, rolls energy, and applies schedule windows and
// manual overrides exactly once each. runShellyReconcile is the tested body;
// this is a thin wrapper on defineCron (which owns the CRON_SECRET check, the
// error boundary and the heartbeat), same skeleton as sonos-reconcile.
//
// Dormant by construction: zero shelly_connections rows → { ok:true,
// locations:0 } and the heartbeat still stamps, so a deploy ahead of the first
// connection never pages. A tick that did NOT complete does not stamp — see
// the heartbeat comment in GET. An explicit ok:false still answers 200 (with
// success:false), as it always has.
//
// Auth: CRON_SECRET.

import { defineCron } from '@/lib/define-cron'
import { runShellyReconcile } from '@/lib/shelly/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Worst case per account ≈ 7 paced calls × (1 s gap + 8 s timeout); accounts
// run 4 in parallel and the run itself stops issuing calls after 90 s.
export const maxDuration = 120

export const GET = defineCron({ heartbeat: 'shelly-reconcile' }, async ({ db }) => {
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
  //
  // `out.ok !== false`, not `out.ok === true`: a dormant deploy must not page.
  // Both false results SHOULD — a sweep that cannot read its own configuration,
  // or cannot trust its clock, is not a quiet minute. They answer 200, as before.
  if (out.ok === false) return { ok: false, status: 200, body: out }
  return { outcome: out, body: out }
})
