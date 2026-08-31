// SENSIBO-RATE.1 follow-up — how much authority a CACHED vendor
// reading is allowed to have.
//
// Since mig 580 the AC surfaces read ac_devices.last_state instead of
// calling the vendor on every request. For DISPLAY that is always
// fine: a reading a few minutes old, labelled with its "as of" time,
// beats hammering a vendor that rate-limits on bursts.
//
// It is NOT fine for the one destructive thing the legacy /ac/state
// route does with pod state: closing an active ac_sessions row when
// the pod reports off ("turned off externally"). Acting on a stale
// "off" would close a session someone restarted at the wall panel
// after the reading was taken — the CRM would then show no session
// while the unit runs on with no auto-off scheduled, which is the
// exact failure mode this whole workstream exists to remove.
//
// So: display uses whatever we have; the destructive path requires a
// reading we know is recent. When it isn't, we leave reconciliation
// to the ac-external-rule and ac-auto-off crons, which take live
// readings on their own tick.

/**
 * A cached reading older than this is display-only.
 *
 * One ac-external-rule tick is 5 minutes, so this allows a full tick
 * plus slack for a slow run. Tighter than a tick would mean the
 * cleanup almost never fires; much looser and we would be acting on
 * information old enough to be wrong.
 */
export const STALE_CLEANUP_MAX_AGE_MS = 8 * 60_000

/**
 * May this reading be used to close an active session?
 *
 * @param {object}  args
 * @param {boolean} args.wantsLive     caller forced a live vendor read
 * @param {string|null} args.observedAt ISO time the reading was taken
 * @param {number}  [args.nowMs]
 * @param {number}  [args.maxAgeMs]
 * @returns {boolean}
 */
export function canCloseStaleSession({
  wantsLive = false,
  observedAt = null,
  nowMs = Date.now(),
  maxAgeMs = STALE_CLEANUP_MAX_AGE_MS,
} = {}) {
  // A live read is authoritative by definition.
  if (wantsLive) return true
  if (!observedAt) return false
  const t = new Date(observedAt).getTime()
  // An unparseable timestamp is treated as no timestamp — the guard
  // may only ever get STRICTER on bad input, never more permissive.
  if (Number.isNaN(t)) return false
  // A clock-skewed future timestamp is not evidence of freshness.
  if (t > nowMs) return false
  return nowMs - t < maxAgeMs
}
