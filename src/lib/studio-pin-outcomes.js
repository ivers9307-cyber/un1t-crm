// STUDIO-PIN — operator-facing labels for pin_login_attempts.outcome.
//
// The device-facing pin-login response is deliberately generic ("Not
// allowed" for every failed gate) so an unauthenticated caller can't
// tell unknown-device from wrong-PIN from untrusted-IP. That
// anti-enumeration posture stays — see src/app/api/auth/pin-login/route.js.
//
// This map is the OPPOSITE side of that trade: a master-only admin view
// (/admin/studio-devices) reads the true `outcome` straight from the
// audit table and renders it in plain English so staff can actually
// debug a device/network setup. Surfacing the truth to an authenticated
// master does not weaken the device-facing generic message.
//
// `tone` is a semantic bucket the UI maps to colour:
//   success → green · warn → amber · error → red · muted → grey.
// `actionable` flags outcomes an operator can directly fix from this
// page (an untrusted IP → add it to the trusted list).

export const PIN_OUTCOME_META = {
  success: { label: 'Signed in', tone: 'success' },
  wrong_pin: { label: 'Wrong PIN', tone: 'warn' },
  untrusted_ip: {
    label: 'Untrusted network — IP not allow-listed',
    tone: 'error',
    actionable: 'trusted_ip',
  },
  unknown_device: { label: 'Unrecognised device token', tone: 'error' },
  device_locked: { label: 'Locked — too many tries', tone: 'error' },
}

/**
 * Describe a raw outcome string for the admin activity view. Unknown
 * values fall back to the raw string with a neutral tone rather than
 * throwing — a new outcome added server-side must never break the page.
 *
 * @param {string} outcome — a pin_login_attempts.outcome value
 * @returns {{ label: string, tone: 'success'|'warn'|'error'|'muted', actionable?: string }}
 */
export function describePinOutcome(outcome) {
  return PIN_OUTCOME_META[outcome] || { label: outcome || 'Unknown', tone: 'muted' }
}

/**
 * Normalise a Postgres `inet` value to a bare host string for display +
 * trusted-IP prefill. PostgREST returns a single-host inet without a
 * mask, but strip a trailing /32 (v4) or /128 (v6) defensively so the
 * value drops cleanly into the trusted-IP form.
 *
 * @param {string|null|undefined} ip
 * @returns {string|null}
 */
export function bareHost(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return null
  return ip.replace(/\/(32|128)$/, '')
}
