// FLEET-CMD.1 — the action model for remote Pi commands.
// Spec: docs/superpowers/specs/2026-08-02-fleet-remote-actions-design.md
//
// THE SECURITY SPINE
// Everything here trades in action NAMES. No function in this file returns,
// accepts, or interpolates a shell command, and none ever should. The CRM
// sends a name; the Pi agent owns the name -> command mapping in its own
// hard-coded table and refuses anything it does not recognise.
//
// The reason is worth restating where someone will read it before changing
// it: if shell text could cross this boundary, then a compromised admin
// session, an injection, or one careless UPDATE would be arbitrary root
// execution on hardware sitting inside the gym. With names, the worst a
// hostile row achieves is rebooting a Pi the operator already controls.
//
// If an action ever needs an argument, give it a typed and validated column.
// Never a free-text field.

/**
 * How long a command may sit undelivered before it is dead.
 *
 * Deliberately tight. These are interactive actions: if it did not land while
 * the operator was looking at the screen, they want to be told, not to have it
 * happen later. A reboot delivered hours after the button was pressed —
 * mid-class, with nobody expecting it — is a worse failure than a button that
 * reported it did not work.
 */
export const COMMAND_TTL_MS = 2 * 60 * 1000

// NOTE — there is deliberately NO reboot suppression window.
//
// The spec called for one (10 minutes, to cover a ~90s reboot). Building it
// showed it could never fire: fleet-health's OFFLINE_AFTER_MS is already 15
// minutes, chosen precisely so the nightly 04:00 fleet reboots do not page
// anyone. A 10-minute window sits entirely inside that patience, so it cannot
// change a single outcome — dead code that looks protective, which is the same
// shape as the hardware_id defect FLEET-ALERT.1 had to fix.
//
// The behaviour we actually want falls out for free:
//   healthy reboot (~90s)  — never grades unreachable, so never alerts
//   hung reboot (>15 min)  — grades unreachable and DOES alert, which is right;
//                            a reboot that never finished is a real outage
//
// Shutdown is the genuine exception and is handled below.

/**
 * The allowlist. `roles` is which device roles the action applies to, and
 * `permission` is the key the caller must hold.
 *
 * `restart_kiosk` and `redeploy_bridge` mirror un1t-pi's deployCommandFor()
 * exactly — they are already hardware-proven. If either changes there, it
 * changes here too, or the two drift.
 */
export const ACTIONS = Object.freeze({
  restart_kiosk: {
    label: 'Restart browser',
    roles: ['kiosk'],
    permission: 'fleet_restart',
    danger: 'safe',
    // pkill -f chromium; the launcher loop relaunches it after 5s.
    blurb: 'Kills Chromium. The launcher brings it back in about 5 seconds.',
  },
  pull_logs: {
    label: 'Pull logs',
    roles: ['kiosk', 'bridge'],
    permission: 'fleet_restart',
    danger: 'safe',
    blurb: 'Reads the last 300 journal lines. Changes nothing on the device.',
  },
  redeploy_bridge: {
    label: 'Redeploy bridge',
    roles: ['bridge'],
    permission: 'fleet_admin',
    danger: 'disruptive',
    blurb: 'git pull and restart champ-bridge. Heart-rate data pauses for a moment.',
  },
  reboot: {
    label: 'Reboot',
    roles: ['kiosk', 'bridge'],
    permission: 'fleet_admin',
    danger: 'disruptive',
    blurb: 'Full restart. The device is offline for roughly 90 seconds.',
  },
  shutdown: {
    label: 'Shut down',
    roles: ['kiosk', 'bridge'],
    permission: 'fleet_admin',
    // Its own class, because it is the only action that cannot be undone from
    // a keyboard: a Pi has no usable wake-on-LAN over WiFi, so a halted device
    // returns when a human unplugs it and plugs it back in. The UI must say so
    // and must require the device name to be typed.
    danger: 'stranding',
    blurb: 'Halts the device. It stays off until someone physically power-cycles it.',
  },
})

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS))

/**
 * Is this a real action name? Guards every entry point — the DB CHECK is the
 * backstop, not the gate.
 *
 * @param {unknown} action
 * @returns {boolean}
 */
export function isKnownAction(action) {
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action)
}

/**
 * Can `action` be run against a device in `role`?
 *
 * An unclaimed device (role null) supports nothing. That is deliberate: the
 * fleet-health cron auto-registers whatever Tailscale reports, so a device can
 * exist here before anyone has said what it is, and guessing would be worse
 * than offering nothing.
 *
 * @param {string} action
 * @param {string|null|undefined} role
 * @returns {boolean}
 */
export function actionAppliesToRole(action, role) {
  if (!isKnownAction(action)) return false
  if (!role) return false
  return ACTIONS[action].roles.includes(role)
}

/**
 * The permission key required to issue `action`, or null if unknown.
 *
 * Callers must check the key for the SPECIFIC action, never the key that got
 * the user onto the page — otherwise holding `fleet_restart` would be enough
 * to POST a shutdown.
 *
 * @param {string} action
 * @returns {string|null}
 */
export function permissionForAction(action) {
  return isKnownAction(action) ? ACTIONS[action].permission : null
}

/**
 * Actions offerable for a device, given the caller's permissions.
 *
 * Filters on role first, then permission, so the UI never renders a button
 * that the API would reject.
 *
 * @param {string|null} role         device role
 * @param {(key: string) => boolean} can  permission predicate
 * @returns {Array<{ action: string } & typeof ACTIONS[keyof typeof ACTIONS]>}
 */
export function availableActions(role, can) {
  return ACTION_NAMES
    .filter((a) => actionAppliesToRole(a, role))
    .filter((a) => can(ACTIONS[a].permission))
    .map((a) => ({ action: a, ...ACTIONS[a] }))
}

/**
 * When a command issued now must be delivered by.
 *
 * @param {number} nowMs
 * @returns {string} ISO timestamp
 */
export function expiryFor(nowMs = Date.now()) {
  return new Date(nowMs + COMMAND_TTL_MS).toISOString()
}

/**
 * How long alerting should be suppressed for a device once `action` is
 * claimed, or null if the action needs no suppression.
 *
 * Only shutdown suppresses, and it suppresses INDEFINITELY. A halted Pi has no
 * expected return — it comes back when a human unplugs it and plugs it back in
 * — so there is no honest deadline to pick. Postgres accepts 'infinity' in a
 * timestamptz, which says exactly that. The window is cleared when the device
 * next reports in.
 *
 * Everything else leaves the device up, or (reboot) returns inside the
 * 15-minute patience fleet-health already applies. See the note above on why a
 * reboot window would have been dead code.
 *
 * The cost of this: a device you shut down and forget is silent forever, by
 * design. The page carries a standing "powered off" list so it stays visible.
 *
 * @param {string} action
 * @param {number} _nowMs  unused; kept so callers need not care which actions suppress
 * @returns {string|null} 'infinity' or null
 */
export function suppressionFor(action, _nowMs = Date.now()) {
  return action === 'shutdown' ? 'infinity' : null
}

/**
 * Has this command missed its delivery window?
 *
 * Used by the agent before executing and by the sweeper when tidying. Both
 * need the same answer, so it lives in one place.
 *
 * @param {{ expires_at: string }} command
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isExpired(command, nowMs = Date.now()) {
  return new Date(command.expires_at).getTime() <= nowMs
}
