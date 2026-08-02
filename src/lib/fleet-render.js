// FLEET-CMD.2 — record that a kiosk's browser is alive.
//
// The TV page polls the live board every 4 seconds. That request arriving is
// the strongest liveness signal available for a wall screen: the process is
// running, the network works, the bundle loaded and React is executing. This
// module writes that fact down, and nothing else.

// Do not write on every poll.
//
// At the 4s active cadence that would be 900 writes per hour per screen, ~21k
// a day, to record a boolean that changes about once a month. One write a
// minute is far more resolution than a 10-minute staleness threshold needs.
export const RENDER_STAMP_THROTTLE_SECONDS = 60

/**
 * Note that `deviceName` rendered, at most once a minute.
 *
 * Deliberately ONE statement with the throttle in its WHERE clause rather than
 * a read-then-write: no round trip to decide, no race between two boards, and
 * a poll that arrives inside the window updates zero rows and costs nothing.
 *
 * The `location_id` predicate is the authorisation. This is called from a
 * PUBLIC, unauthenticated endpoint, so the device name alone must not be
 * enough — a name is only accepted for the location whose board is being
 * fetched. The residual risk is small and worth stating plainly: someone who
 * knows both a device name and its location UUID could keep a dead screen
 * looking alive. They cannot read anything, write any other column, or affect
 * another location. The proper fix is the token-gated
 * /api/public/tv-live/[token] entrypoint that P0-3 is already migrating TVs
 * onto; when every kiosk is on it, resolve the device from the token instead
 * and drop the query param.
 *
 * Never throws: this is telemetry hanging off the request that renders the
 * studio board, and a failed stamp must never cost anyone their leaderboard.
 *
 * @param {object} db          service-role Supabase client
 * @param {string|null} deviceName  from ?device= on the poll
 * @param {string} locationId  the board being fetched
 * @returns {Promise<void>}
 */
export async function stampRender(db, deviceName, locationId) {
  if (!deviceName || !locationId) return
  try {
    const cutoff = new Date(Date.now() - RENDER_STAMP_THROTTLE_SECONDS * 1000).toISOString()
    await db
      .from('fleet_devices')
      .update({ last_render_at: new Date().toISOString() })
      .eq('device_name', deviceName)
      .eq('location_id', locationId)
      .or(`last_render_at.is.null,last_render_at.lt.${cutoff}`)
  } catch {
    // Swallowed on purpose — see above.
  }
}

/**
 * Pull `?device=` off a request, or null.
 *
 * Bounded and character-restricted because it reaches a query from an
 * unauthenticated endpoint. Device names are Tailscale hostnames, so
 * lowercase alphanumerics and hyphens is the whole legal alphabet.
 *
 * @param {Request} request
 * @returns {string|null}
 */
export function deviceFromRequest(request) {
  // Guarded, because this sits on the path that renders the studio board and
  // must not be capable of breaking it. `new URL` throws on a relative or
  // malformed url — which a real Next request never has, but a test double or
  // a future caller might, and "no device" is the right answer either way.
  let raw
  try {
    raw = new URL(request?.url ?? '').searchParams.get('device')
  } catch {
    return null
  }
  if (!raw || raw.length > 64) return null
  return /^[a-z0-9-]+$/.test(raw) ? raw : null
}
