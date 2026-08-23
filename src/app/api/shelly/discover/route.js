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

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logWarn, logError } from '@/lib/log'
import { createShellyClient } from '@/lib/shelly/client'
import { loadConnectionWithKey } from '@/lib/shelly/connections'
import { normaliseAllStatus } from '@/lib/shelly/status'
import { AUTH_ERROR } from '@/lib/shelly/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-discover'

// Estate-wide read, so it is bounded. A truncated page can only mislabel a row
// as un-adopted (see the warn below); it can never invent a holder.
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
      // connection. The cron's markConnection writes the same three fields for
      // the same reason (reconcile.js) — a staff-triggered discovery that hits
      // a dead key should light the same badge the next tick would.
      const nowIso = new Date().toISOString()
      const { error: markError } = await db
        .from('shelly_connections')
        .update({ status: 'action_needed', last_error: AUTH_ERROR, last_error_at: nowIso, updated_at: nowIso })
        .eq('location_id', locationId)
      // Best effort, and deliberately NOT fatal: a failed badge write costs a
      // stale chip, while turning it into a 500 would replace the one answer
      // the operator can act on ("re-paste your key") with one they cannot.
      // The row provably exists — it was read by this same key moments ago —
      // so a zero-row update is not a case worth distinguishing here.
      if (markError) logWarn(MODULE, 'connection status write failed', { locationId, error: markError.message })
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
      .select('device_id, channel, location_id, locations!location_id(name, organization_id)')
      .in('device_id', uniqueIds)
      .limit(HOLDER_ROW_CAP)
    if (error) {
      // NEVER answer "not adopted" from a failed read. The absence of a holder
      // row is what tells the operator a device is free, so a read error that
      // degraded to `adopted: null` would invite an adopt that then 409s with
      // a message contradicting the list they were just shown.
      logError(MODULE, 'holder lookup failed', { locationId, error: error.message })
      return bad('Could not check device ownership', 500)
    }
    holders = data || []
    if (holders.length >= HOLDER_ROW_CAP) {
      // Warned, not refused — unlike findFingerprintRows, where a truncated
      // read might hide the foreign holder that should have REFUSED a link.
      // Here the authoritative check is the adopt route's own holder query;
      // this one only decorates a list, and a mislabelled chip costs a named
      // 409 at adopt, not a cross-tenant mistake.
      logWarn(MODULE, 'holder lookup hit the row cap — some chips may read as un-adopted', {
        locationId, cap: HOLDER_ROW_CAP,
      })
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

  return NextResponse.json({ success: true, devices, count: devices.length })
})
