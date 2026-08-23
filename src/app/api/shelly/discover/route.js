// SHELLY-UI.4 — what is on this location's Shelly account, and which of those
// relays are already spoken for.
//
// THE HOLDER LOOKUP BELOW IS CROSS-TENANT BY DESIGN, and it is the only query
// in this file that is. Seeing rows that are NOT ours is the entire point:
// (device_id, channel) is UNIQUE across the whole estate (mig 562), so a relay
// adopted by another business is un-adoptable here, and an operator who is not
// told that would hit an unexplained 409 at adopt time. Two consequences
// follow, and both are enforced below rather than assumed:
//
//   * it is sound ONLY on the service-role client. An RLS-bound client cannot
//     see another organisation's row at all, so it would answer "no holder" —
//     which is the answer that says "go ahead and adopt".
//   * the ROW may cross a tenant boundary; the RESPONSE may not. Nothing from
//     a foreign holder reaches the caller except the single word 'elsewhere',
//     plus the location NAME when — and only when — that location is in the
//     caller's own organisation. No location id, no organisation id, no host.
//
// The device list itself comes from the caller's OWN cloud account, so names,
// models and online flags are theirs already; our database contributes exactly
// one field to each row (`adopted`) and, same-org only, one more.
//
// locationId ALWAYS comes from withAuth's ctx. Nothing in a query string can
// move a caller to another location's Shelly account.
//
// NOTE FOR check:location-scoping — this file has no `.eq('location_id', …)`
// on shelly_devices, by design. What the scan reads as its tenant evidence is
// the `holder.location_id === locationId` comparison in the mask, which is
// genuinely where this route decides what belongs to the caller (the
// fetch-then-compare shape the script documents). If that comparison is ever
// refactored away, the scan will fire — correctly: the masking IS the
// boundary here, so losing it is not a lint problem to silence.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logWarn, logError } from '@/lib/log'
import { createShellyClient } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { normaliseAllStatus } from '@/lib/shelly/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-discover'

// Estate-wide read, so it is bounded. The query asks for one MORE than this
// (the findFingerprintRows pattern) so a full page and a truncated one are
// distinguishable: exactly HOLDER_ROW_CAP rows is a complete answer, one over
// means there may be holders we cannot see. Truncation here is NON-FATAL,
// unlike in findFingerprintRows — a row we missed can only mislabel a chip as
// un-adopted, and the adopt route's own holder check is the authoritative one,
// so the cost is a named 409 at adopt rather than a cross-tenant mistake.
const HOLDER_ROW_CAP = 500

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

/**
 * GET — every relay channel the connected Shelly account can see, masked.
 *
 * Response rows are built field by field from the normaliser's output, never
 * spread from a database row: this endpoint's whole job is to publish a list
 * derived partly from other tenants' data, so the projection is the security
 * boundary and it is written out explicitly.
 */
export const GET = withAuth({ permission: 'device_control' }, async ({ user, db, locationId }) => {
  // The key is needed to talk to the cloud, so this is loadConnectionWithKey,
  // not loadPublicConnection — and the row it returns must never be spread
  // into a response or a log line.
  const loaded = await loadConnectionWithKey(db, locationId)
  if (!loaded.ok) {
    if (loaded.reason === 'not_connected') {
      return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
    }
    // A read that FAILED is not "not connected" — answering the not_connected
    // code would send the operator to the Connect form to re-paste a
    // credential that is working fine (same rule as GET /api/shelly/connection).
    logError(MODULE, 'connection read failed', { locationId, reason: loaded.reason, error: loaded.error })
    return bad('Could not read the Shelly connection', 500)
  }
  const conn = loaded.connection

  const res = await createShellyClient(conn).allStatus()
  if (!res.ok) {
    if (res.kind === 'auth') {
      // Only `auth` means the stored key is wrong, so only `auth` parks the
      // connection. markKeyRejected writes the same three fields the cron
      // does, from the same module, so a staff-triggered discovery and the
      // next tick cannot describe a dead key differently. It logs its own
      // failure and is deliberately NOT fatal here: a failed badge write costs
      // a stale chip, while turning it into a 500 would replace the one answer
      // the operator can act on with one they cannot.
      await markKeyRejected(db, locationId)
      return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
    }
    // 429 rather than 502 for a rate limit: the shared 1 req/sec budget is
    // most often the same owner's other studio mid-reconcile, which is a
    // retry-after condition and not a broken far end.
    if (res.kind === 'rate_limited') {
      return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
    }
    // `kind` is the vocabulary (statusCode 0 is overloaded — client.js header).
    // The result BODY is never logged: results carry response bodies verbatim
    // and the key rides in the v1 form body.
    logWarn(MODULE, 'discovery read failed', { locationId, kind: res.kind, statusCode: res.statusCode })
    return bad('Shelly cloud did not answer — try again in a minute', 502, { code: res.kind })
  }

  const readings = normaliseAllStatus(res.body)

  // ——— cross-tenant holder lookup (see the file header) ———————————————
  const uniqueIds = [...new Set(readings.map((r) => r.device_id))]
  let holders = []
  if (uniqueIds.length) {
    const { data, error } = await db
      .from('shelly_devices')
      // Unhinted embed: shelly_devices has exactly ONE foreign key to
      // locations, so there is nothing to disambiguate, and this is the form
      // connections.js and reconcile.js already run against the live database.
      .select('device_id, channel, location_id, locations(name, organization_id)')
      .in('device_id', uniqueIds)
      .limit(HOLDER_ROW_CAP + 1)
    if (error) {
      // NEVER answer "not adopted" from a failed read. The absence of a holder
      // row is what tells the operator a device is free, so a read error that
      // degraded to `adopted: null` would invite an adopt that then 409s with
      // a message contradicting the list they were just shown.
      logError(MODULE, 'holder lookup failed', { locationId, error: error.message })
      return bad('Could not check device ownership', 500)
    }
    holders = data || []
    if (holders.length > HOLDER_ROW_CAP) {
      // Warned, not refused — see the constant. Sliced so the extra probe row
      // never reaches the map.
      logWarn(MODULE, 'holder lookup hit the row cap — some chips may read as un-adopted', {
        locationId, cap: HOLDER_ROW_CAP,
      })
      holders = holders.slice(0, HOLDER_ROW_CAP)
    }
  }
  const byChannel = new Map(holders.map((h) => [`${h.device_id}_${h.channel}`, h]))

  const callerOrg = user.activeLocation?.organization_id
  const devices = readings.map((r) => {
    const row = {
      device_id: r.device_id,
      channel: r.channel,
      name: r.name,
      model: r.model,
      gen: r.gen,
      online: r.online,
      // Tri-state, passed through as-is: false is a verdict ("cannot be
      // adopted"), null is "the device told us nothing yet" (status.js rule 2)
      // and must not render as a dead end.
      supported: r.supported,
      adopted: null,
    }
    if (r.reason) row.reason = r.reason

    const holder = byChannel.get(`${r.device_id}_${r.channel}`)
    if (holder) {
      if (holder.location_id === locationId) {
        row.adopted = 'here'
      } else {
        row.adopted = 'elsewhere'
        const holderOrg = holder.locations?.organization_id
        // Both sides must be present AND equal. `holderOrg === callerOrg`
        // alone would read undefined === undefined as "same organisation" —
        // a dropped embed or a caller with no org would then name every
        // foreign location on the estate. Same rule as
        // classifyFingerprintClash, and the same reason it is written this way.
        if (holderOrg && callerOrg && holderOrg === callerOrg) {
          row.elsewhere_location_name = holder.locations?.name || 'another location'
        }
      }
    }
    return row
  })

  // `row_count`, not `count`: a four-relay Pro 4PM is ONE device and FOUR rows
  // here, so a field called `count` next to Task 3's `devices_seen` (which
  // counts devices) would read as the same number and quietly disagree.
  return NextResponse.json({ success: true, devices, row_count: devices.length })
})
