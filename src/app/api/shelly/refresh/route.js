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
import { logError } from '@/lib/log'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { DEVICE_COLUMNS, withLocationTz } from '@/lib/shelly/device-load'
import { refreshLocationState } from '@/lib/shelly/reconcile'
import { MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-refresh'

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

  // The zone graft matters here too: refreshLocationState builds its own
  // client from this object, and reconcile's helpers read conn.locations.
  const out = await refreshLocationState(db, withLocationTz(conn.connection, user), devices, { now: Date.now })

  if (out.auth) {
    // Only `auth` is evidence about the credential. It parks the connection
    // with the same three fields and the same copy the cron writes.
    await markKeyRejected(db, locationId)
    return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
  }
  // A rate limit that cost us EVERY reading is a 429; one that merely slowed a
  // batch down is not — the operator got their refresh, and telling them to
  // back off would be false.
  if (out.rateLimited > 0 && out.stateWrites === 0) {
    return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
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
