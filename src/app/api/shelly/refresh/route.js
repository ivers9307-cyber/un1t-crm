// SHELLY-UI.5 — "refresh now": one batched read of this location's plugs, so
// the page does not have to wait up to a minute for the cron to tell it what
// the watts are.
//
// IT IS THE CRON'S OWN STEP, NOT A COPY OF IT. refreshLocationState is exactly
// steps 2 and 3 of a location's tick (reconcile.js), lifted out precisely so
// this route could call it: same batching, same "only a batch that SUCCEEDED
// speaks for its ids" rule, same deadband on the writes. A second
// implementation here would be a second opinion about what a plug's state is.
//
// IT COMMANDS NOTHING. Reads and last_state writes only — no relay moves, no
// schedule is applied. That is what makes it safe to put behind a button an
// operator can press repeatedly, and it is why a rate limit is the one failure
// worth an HTTP 429: the shared 1 req/sec budget is most often the same
// owner's other studio mid-reconcile, and pressing again is the wrong move.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { HOST_ERROR, loadConnectionWithKey, markConnectionStatus, markKeyRejected } from '@/lib/shelly/connections'
import { DEVICE_COLUMNS, withLocationTz } from '@/lib/shelly/device-load'
import { refreshLocationState } from '@/lib/shelly/reconcile'
import { MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-refresh'

// A BUDGET, because this one runs on a request thread. Unbounded, 50 devices
// is five batches plus the client's own retries — measured at roughly 14
// seconds — and a platform 504 tells the operator nothing and writes nothing.
// refreshLocationState checks this before each batch, logs 'time budget
// exhausted' and returns the counters for the batches it DID complete, so a
// slow account degrades to a partial refresh instead of an error page.
const REFRESH_BUDGET_MS = 8_000

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

export const POST = withAuth({ permission: 'device_control' }, async ({ user, db, locationId }) => {
  const conn = await loadConnectionWithKey(db, locationId)
  if (!conn.ok) {
    if (conn.reason === 'not_connected') {
      return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
    }
    logError(MODULE, 'connection read failed', { locationId, reason: conn.reason, error: conn.error })
    return bad('Could not read the Shelly connection', 500)
  }

  const { data, error } = await db
    .from('shelly_devices')
    .select(DEVICE_COLUMNS)
    .eq('location_id', locationId)
    // The cap the cron itself reconciles per tick. Reading further would poll
    // devices no schedule will ever act on.
    .limit(MAX_DEVICES_PER_LOCATION)
  if (error) {
    logError(MODULE, 'device list failed', { locationId, error: error.message })
    return bad('Could not load your Shelly devices', 500)
  }
  const devices = data || []
  if (!devices.length) {
    // No cloud call at all. A location with nothing adopted spending a slot of
    // the shared account budget to learn that would starve the studio next
    // door mid-reconcile.
    return NextResponse.json({ success: true, refreshed: 0, read_failures: 0, rate_limited: 0, kind: null })
  }

  // NOTHING ON THIS PATH RESOLVES A TIMEZONE — refreshLocationState reads and
  // writes last_state, it does not plan anything, and the client it builds
  // needs only host + auth_key. The graft is future-proofing and consistency
  // with the two routes that DO need it (toggle, run-now): if a zone-dependent
  // step is ever added to this helper, it will already be given the same
  // answer the rest of the surface uses rather than silently falling back to
  // Dublin.
  const out = await refreshLocationState(db, withLocationTz(conn.connection, user), devices, {
    now: Date.now,
    deadlineAt: Date.now() + REFRESH_BUDGET_MS,
  })

  // The verdict is read off the UN-CONFLATED signals the engine already
  // separates, never off the counters. `rateLimited` counts a RETRIED SUCCESS
  // as well as a 429 (reconcile.js says so), and `stateWrites === 0` is the
  // healthy answer for a studio whose readings have not moved — judging on
  // that pair told a perfectly refreshed location to back off.
  if (out.auth) {
    // Only `auth` is evidence about the credential. It parks the connection
    // with the same three fields and the same copy the cron writes.
    await markKeyRejected(db, locationId)
    return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
  }
  if (out.config) {
    // A bad host never reached the network, so no amount of retrying helps —
    // it is the connection settings, and the badge says so with the same
    // literal the cron writes.
    await markConnectionStatus(db, locationId, {
      status: 'action_needed', last_error: HOST_ERROR, last_error_at: new Date().toISOString(),
    })
    return bad(HOST_ERROR, 409, { code: 'bad_host' })
  }
  // NOT ONE batch succeeded, and the budget is why: a retry in a few seconds
  // is the right advice, and 429 is how the client is told to wait rather than
  // re-press.
  if (!out.anyOk && out.budgetHit) {
    return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
  }
  // Nothing succeeded for some other reason, having actually tried. The
  // schedule is untouched by this — the cron owns that, and this route only
  // reads — so the copy says so rather than implying the studio is now adrift.
  if (!out.anyOk && out.reads > 0) {
    logWarn(MODULE, 'refresh read nothing', {
      locationId, reads: out.reads, readFailures: out.readFailures, kind: out.lastKind, stalled: out.stalled,
    })
    return bad('Could not read your plugs just now — the schedule is unaffected', 502, {
      code: out.lastKind ?? 'unreachable',
    })
  }

  return NextResponse.json({
    success: true,
    // Rows whose state actually CHANGED — the deadband swallows a wattmeter
    // twitching in the third decimal, so this is honestly smaller than "how
    // many devices we read".
    refreshed: out.stateWrites,
    read_failures: out.readFailures,
    rate_limited: out.rateLimited,
    kind: out.lastKind ?? null,
  })
})
