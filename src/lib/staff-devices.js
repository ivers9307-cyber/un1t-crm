// Staff device verdicts (STAFF-DEV) — the single source of truth for
// "what version is this staff member on, and are they behind?".
//
// PURE MODULE: no IO, no Supabase, and deliberately NO `Date.now()` —
// the clock is injected as a `now` (epoch ms) argument so every caller
// (server component, route, test) shares one comparable notion of now
// and tests need no fake timers. Same design as
// `mobile/lib/foreground-update-logic.js`.
//
// Definitions (mirrored in docs/superpowers/specs/2026-07-31-...):
//   - Current device = the row with the greatest `last_seen_at`. EVERY
//     verdict keys off it, never off the best version the person owns:
//     an old iPad left on a newer build must not mask a daily phone
//     that has been downgraded or never updated.
//   - Stale device = not seen in STALE_AFTER_DAYS. Rendered dimmed and
//     never allowed to set the target version (an abandoned beta must
//     not put the whole fleet permanently "behind").
//   - Target version = highest parseable `app_version` across the
//     non-stale fleet. No operator setting — it self-updates when a new
//     build lands.
//
// Rows older than 90 days are deleted by the sweep-stale-push-tokens
// cron, so "no_device" already means "nothing in 90 days"; this module
// deliberately adds no competing 90-day rule.

/** Days without a `last_seen_at` heartbeat before a device is considered stale. */
export const STALE_AFTER_DAYS = 30

const DAY_MS = 86400_000
const LEADING_DIGITS = /^\d+/
/** Largest value any one version segment may hold — see parseVersion's security note. */
const MAX_SEGMENT = 9999

/**
 * Parse a loosely-semver `app_version` into comparable numbers.
 *
 * Tolerates the historical junk in the column: a leading `v`, missing
 * minor/patch (`'2'` → 2.0.0), and prerelease/build suffixes
 * (`'2.2.0-beta.1'` → 2.2.0 — prerelease ordering is ignored by design;
 * we only ever ask "is this build behind the fleet?"). Only the first
 * three segments are read, so a 4th is truncated: `'2.2.0.1'` compares
 * equal to `'2.2.0'`.
 *
 * ON THE SEGMENT CAP — what it does and does not buy: `app_version` is
 * client-reported, and the highest one in the fleet becomes the target
 * every other staff member is measured against (and, via the nudge,
 * pushed about). Rejecting a segment outside 0–MAX_SEGMENT bounds the
 * MAGNITUDE of a poisoned value; it does NOT remove the capability. Any
 * authenticated staff session can still POST `'9999.0.0'` to
 * /api/mobile/device-tokens and mark the whole fleet outdated — the cap
 * only stops the absurd end of that (and keeps the numbers safe to
 * compare). Real defence would be an operator-set target version or
 * trusting only store-published builds; neither is built. The mobile
 * register endpoint validates the same shape so the two can't disagree
 * about what is storable.
 *
 * @param {string|null|undefined} str
 * @returns {[number, number, number]|null} null when unparseable or out of range.
 */
export function parseVersion(str) {
  if (typeof str !== 'string') return null
  const trimmed = str.trim().replace(/^v/i, '')
  if (!trimmed) return null
  const parts = trimmed.split('.')
  const out = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const match = (parts[i] ?? '').match(LEADING_DIGITS)
    // The major segment must be a real number; minor/patch default to 0.
    if (!match) {
      if (i === 0) return null
      continue
    }
    const n = Number(match[0])
    if (!Number.isSafeInteger(n) || n > MAX_SEGMENT) return null
    out[i] = n
  }
  return out
}

/**
 * Compare two `app_version` strings numerically (so 2.10.0 > 2.9.0).
 *
 * Unparseable/missing versions sort LOWEST and are never equal to a real
 * version; two unparseable values compare equal.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/** @param {{ last_seen_at?: string|null }} device @returns {number} epoch ms, -Infinity when unknown. */
function seenAtMs(device) {
  const raw = device?.last_seen_at
  if (!raw) return -Infinity
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? -Infinity : ms
}

/**
 * The device every verdict keys off: the most recently seen row.
 *
 * Rows with no (or an unparseable) `last_seen_at` sort last rather than
 * throwing; selection is stable, so the first row wins a tie.
 *
 * @param {Array<object>|null|undefined} devices
 * @returns {object|null}
 */
export function currentDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return null
  let best = null
  let bestMs = -Infinity
  for (const device of devices) {
    if (!device) continue
    const ms = seenAtMs(device)
    if (best === null || ms > bestMs) {
      best = device
      bestMs = ms
    }
  }
  return best
}

/**
 * Has this device gone quiet for longer than STALE_AFTER_DAYS?
 *
 * A row with no `last_seen_at` counts as stale — unknown recency must
 * never be treated as "active" (it would let a mystery row set the
 * target version for everyone).
 *
 * The clock is required: a missing/NaN `now` would make every comparison
 * false and silently mark the entire fleet fresh, so it throws instead.
 *
 * @param {{ last_seen_at?: string|null }} device
 * @param {number} now epoch ms (injected clock)
 * @returns {boolean}
 */
export function isStale(device, now) {
  if (!Number.isFinite(now)) throw new TypeError('isStale: now must be epoch ms')
  const ms = seenAtMs(device)
  if (ms === -Infinity) return true
  return now - ms > STALE_AFTER_DAYS * DAY_MS
}

/**
 * The version the fleet is expected to be on: the highest parseable
 * `app_version` among devices seen in the last STALE_AFTER_DAYS.
 *
 * Stale devices are excluded so an abandoned beta install cannot set
 * the bar for everyone else.
 *
 * @param {Array<object>|null|undefined} devices every device in scope
 * @param {number} now epoch ms (injected clock)
 * @returns {string|null} the raw version string, or null when nothing is parseable.
 */
export function deriveTargetVersion(devices, now) {
  if (!Array.isArray(devices)) return null
  let target = null
  for (const device of devices) {
    if (!device || isStale(device, now)) continue
    const version = device.app_version
    if (!parseVersion(version)) continue
    if (target === null || compareVersions(version, target) > 0) target = version
  }
  return target
}

/**
 * @typedef {object} DeviceVerdict
 * @property {'no_device'|'unknown_version'|'outdated'|'current'} kind
 * @property {string|null} version   the current device's reported version
 * @property {string|null} deviceId  the current device's id
 * @property {string|null} lastSeenAt
 * @property {boolean} stale         is the current device itself stale?
 */

/**
 * The per-staff verdict, computed from that person's device rows.
 *
 * Keys off the CURRENT (most recently seen) device, not the best version
 * the person owns. `no_device` when they have no rows at all;
 * `unknown_version` when the current device never reported a parseable
 * version; `outdated` only when there is a target to compare against —
 * with no target, nobody is behind.
 *
 * @param {Array<object>|null|undefined} devices this profile's device rows
 * @param {string|null} targetVersion from deriveTargetVersion()
 * @param {number} now epoch ms (injected clock)
 * @returns {DeviceVerdict}
 */
export function deviceVerdict(devices, targetVersion, now) {
  const device = currentDevice(devices)
  if (!device) {
    return { kind: 'no_device', version: null, deviceId: null, lastSeenAt: null, stale: false }
  }
  const base = {
    version: device.app_version ?? null,
    deviceId: device.id ?? null,
    lastSeenAt: device.last_seen_at ?? null,
    stale: isStale(device, now),
  }
  if (!parseVersion(device.app_version)) return { kind: 'unknown_version', ...base }
  if (!parseVersion(targetVersion)) return { kind: 'current', ...base }
  const kind = compareVersions(device.app_version, targetVersion) < 0 ? 'outdated' : 'current'
  return { kind, ...base }
}

/** A device is "recently seen" for push-health purposes within this window. */
export const PUSH_HEALTHY_DAYS = 14

/**
 * ANDROID-VIS.1b — the per-staff verdict on /settings/notifications/health.
 *
 * Lifted out of the page so it can be tested, because it acquired a state
 * that MATTERS: since mig 565 a device row no longer implies a push token,
 * and the previous logic called a token-less device 🟢 Healthy. That is a
 * confident lie on the one surface whose entire job is answering "would a
 * push reach this phone" — and it sat next to a live "Send test push"
 * button that could never do anything. Every Android device in the fleet
 * would have rendered that way.
 *
 * Order matters: unreachable outranks stale. "We cannot push to this phone
 * at all" is a more useful and more actionable fact than "we could, but its
 * token may have aged out".
 *
 * `canPush` is the single source of truth for whether the test-push button
 * is offered — never re-derive it from `kind` at a call site.
 *
 * @param {Array<{last_seen_at?: string|null, expo_push_token?: string|null}>} devices
 * @param {number} now  injected clock; the lib stays pure
 */
export function pushHealthStatus(devices, now = Date.now()) {
  const list = Array.isArray(devices) ? devices : []
  if (!list.length) return { kind: 'red', label: 'No app', canPush: false }

  const newest = list.reduce(
    (max, d) => (!max || (d?.last_seen_at && d.last_seen_at > max) ? d?.last_seen_at : max),
    null,
  )
  if (!newest) return { kind: 'red', label: 'No app', canPush: false }

  // A missing key reads the same as an explicit null: a caller that forgot
  // to select the column must not be told everyone is reachable.
  if (!list.some((d) => d?.expo_push_token)) {
    return { kind: 'nopush', label: 'Visible, no push', canPush: false }
  }

  const daysSince = (now - new Date(newest).getTime()) / DAY_MS
  if (daysSince > PUSH_HEALTHY_DAYS) return { kind: 'amber', label: 'Stale', canPush: true }
  return { kind: 'green', label: 'Healthy', canPush: true }
}

// --- REPSET-PUB.1A — which iOS BINARY is this device running? ------------

/**
 * A build number is a non-negative integer counter (EAS owns it under
 * `appVersionSource: 'remote'`). Digits only, deliberately: `native_build`
 * is client-reported text, and anything else — `'2.3.0'`, `'1e3'`, `'abc'`,
 * a fractional number — is a value we cannot honestly compare, not a value
 * to coerce.
 */
const BUILD_DIGITS = /^\d{1,10}$/

/** @returns {number|null} null when the value is absent or unparseable — NEVER 0. */
function parseBuild(value) {
  // A caller holding Constants.nativeBuildVersion straight off a device may
  // have a number (Android reports versionCode numerically); the column is
  // text. Both are accepted, neither is coerced from junk.
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!BUILD_DIGITS.test(trimmed)) return null
  return Number(trimmed)
}

/**
 * REPSET-PUB.1A — is this device on the OLD unlisted iOS app or the NEW
 * public `ie.repset.app` one?
 *
 * Apple's unlisted-distribution rule is one-way, so the public app is a new
 * App Store record with a new bundle id, while the old app keeps serving its
 * installed base off the SAME OTA lane until sunset. Nothing on a
 * `device_tokens` row separates the two by itself: `app_version` is the
 * OTA-delivered JS version and is identical on both, and the bundle id
 * cannot be read honestly from JS at all (`Constants.expoConfig` reflects
 * the OTA-delivered config, so an old binary would report the new id once
 * the config PR publishes). `native_build` — the binary's Info.plist build
 * number, mig 567 — is OTA-immune, and EAS's remote build counter is
 * monotonic across the shared project, so one threshold splits them:
 * `lastOldIosBuild` (N) is the old app's FINAL build number.
 *
 * PURE and total. Four answers, and the two "we cannot say" ones are not
 * interchangeable:
 *   - `'n/a'`      — not iOS. Android keeps one app record and one package
 *                    name, so it has no old-vs-new question; putting those
 *                    devices in either bucket would corrupt the rollup.
 *   - `'unknown'`  — iOS, but the build or the threshold is missing or
 *                    unparseable. ABSENT IS NOT ZERO: every row written
 *                    before 1A has a NULL `native_build`, and reading that
 *                    as build 0 would report the whole fleet as un-migrated
 *                    on no evidence.
 *   - `'old-app'`  — build <= N. The boundary is INCLUSIVE because N is the
 *                    old app's last build, not the new app's first.
 *   - `'new-app'`  — build > N.
 *
 * N IS NOT WIRED ANYWHERE YET. It is read off EAS/ASC at Phase 2 and
 * threaded in at Phase 4, when the migration report is built; until then
 * this export exists so the report has one definition to share and the
 * health page can just display the raw number.
 *
 * @param {string|null|undefined} platform      the row's `platform`
 * @param {string|number|null|undefined} nativeBuild  the row's `native_build`
 * @param {string|number|null|undefined} lastOldIosBuild  N
 * @returns {'old-app'|'new-app'|'unknown'|'n/a'}
 */
export function classifyBinary(platform, nativeBuild, lastOldIosBuild) {
  const os = typeof platform === 'string' ? platform.trim().toLowerCase() : ''
  if (os !== 'ios') return 'n/a'

  const build = parseBuild(nativeBuild)
  const threshold = parseBuild(lastOldIosBuild)
  if (build === null || threshold === null) return 'unknown'

  return build <= threshold ? 'old-app' : 'new-app'
}
