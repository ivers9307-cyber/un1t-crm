// Resolve which configured location a UniFi (Access or Protect) webhook
// belongs to.
//
// History: the single-location deploy resolved location as "exactly one
// candidate → use it, else null". The moment a SECOND UniFi controller exists
// that `length === 1` test fails for EVERY event, so all attendance/door
// webhooks are silently dropped (returns 200 ignored). This blocks Hatch St.
//
// Fix: prefer an explicit controller-id match so each controller resolves to
// its own location; fall back to the single configured location so today's
// single-controller deploy is byte-for-byte unchanged.
//
// `controllerId` is whatever stable identifier the webhook carries for its
// source controller / NVR / site (UniFi's internal UUID/host/MAC). The operator
// stores the matching value in `settings.unifi.controller_id` (Access) or
// `settings.unifi_protect.controller_id` (Protect). NOTE: the exact payload
// field must be verified against a real second-controller event before relying
// on it for Hatch St — until then the single-location fallback carries it.

/**
 * Pull the best-effort controller identifier out of a UniFi webhook payload.
 * Checks the payload-level id fields and the first event's `location` UUID.
 * @returns {string|null}
 */
export function unifiControllerId(payload) {
  const p = payload || {}
  const ev = Array.isArray(p.events) ? p.events[0] : null
  return (
    p.controller_id || p.host || p.nvr_mac || p.mac ||
    (ev && ev.location) || p.location || null
  )
}

/**
 * @param {Array<{id:string, settings?:object}>} candidateLocations  locations with UniFi configured
 * @param {string|null} controllerId  identifier from unifiControllerId(payload)
 * @returns {object|null} the resolved location, or null when ambiguous
 */
export function resolveUnifiLocation(candidateLocations, controllerId) {
  const cands = candidateLocations || []
  const id = controllerId == null ? '' : String(controllerId).trim()
  if (id) {
    const match = cands.find((l) => {
      const s = l.settings || {}
      const ids = [
        s.unifi?.controller_id, s.unifi?.site_id, s.unifi?.host,
        s.unifi_protect?.controller_id, s.unifi_protect?.site_id, s.unifi_protect?.host,
      ].filter(Boolean).map(String)
      return ids.includes(id)
    })
    if (match) return match
  }
  // Fallback: single configured controller → that location (unchanged today).
  return cands.length === 1 ? cands[0] : null
}
