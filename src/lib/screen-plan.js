// SCREENMODE.5 — the IO half of the screen scheduler. Reads a studio's
// screen_mode automation, its class occurrences and the device's cast display,
// and assembles the plan body the endpoint returns to a box (buildScreenPlan).
// expectedModesFor answers "what mode should each box be in right now" for the
// fleet page from the same reads, once per studio. The pure planning lives in
// screen-mode.js.
//
// A box must never be refused a plan because one read failed: a failure sets
// `degraded` (first one met wins) and the plan still goes out, with no windows
// when the windows could not be trusted. A zone is never guessed.

import {
  planScreenWindows,
  modeAt,
  resolveScreenConfig,
  SCREEN_MODE_KEY,
  SCREEN_MODES,
  PLAN_LOOKBACK_MS,
  PLAN_LOOKAHEAD_MS,
  PLAN_POLL_SECONDS,
} from '@/lib/screen-mode'
import { getLocationZone, LocationZoneReadError } from '@/lib/location-time'
import { getAppUrl } from '@/lib/app-url'
import { logWarn } from '@/lib/log'

// What the endpoint selects from fleet_devices and hands to buildScreenPlan.
export const SCREEN_DEVICE_COLUMNS =
  'device_name, role, location_id, tv_display_id, override_mode, override_until'

const LOG = 'screen-plan'

/**
 * The studio's screen_mode automation row, or null when there is none.
 * @returns {Promise<{ row: object|null, error: boolean }>}
 */
async function readAutomation(db, locationId) {
  const { data, error } = await db
    .from('location_automations')
    .select('location_id, config, enabled')
    .eq('location_id', locationId)
    .eq('automation_key', SCREEN_MODE_KEY)
    .maybeSingle()
  if (error) {
    logWarn(LOG, 'screen_mode automation unreadable', { locationId, error: error.message })
    return { row: null, error: true }
  }
  return { row: data || null, error: false }
}

/**
 * The windows for one studio: zone, then occurrences, then the pure planner.
 * Never throws for a failed read; says which read failed instead.
 * @returns {Promise<{ windows: Array, timezone: string|null, degraded: string|null }>}
 */
async function planStudioWindows(db, locationId, config, nowMs) {
  let timezone
  try {
    timezone = await getLocationZone(db, locationId)
  } catch (err) {
    if (!(err instanceof LocationZoneReadError)) throw err
    logWarn(LOG, 'location timezone unreadable; no windows planned', { locationId, error: err.message })
    return { windows: [], timezone: null, degraded: 'zone_unreadable' }
  }

  const { data: occurrences, error } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at')
    .eq('location_id', locationId)
    .is('cancelled_at', null)
    .gte('starts_at', new Date(nowMs - PLAN_LOOKBACK_MS).toISOString())
    .lte('starts_at', new Date(nowMs + PLAN_LOOKAHEAD_MS).toISOString())
    .order('starts_at', { ascending: true })
  if (error) {
    logWarn(LOG, 'class occurrences unreadable; no windows planned', { locationId, error: error.message })
    return { windows: [], timezone, degraded: 'occurrences_unreadable' }
  }

  return {
    windows: planScreenWindows({ occurrences: occurrences || [], config, zone: timezone }),
    timezone,
    degraded: null,
  }
}

/** The device's override while it is live (known mode, `until` still ahead of now), else null. */
function liveOverride(device, nowMs) {
  const { override_mode: mode, override_until: until } = device
  if (!mode || !SCREEN_MODES.includes(mode) || !until) return null
  const untilMs = Date.parse(until)
  return Number.isFinite(untilMs) && untilMs > nowMs ? { mode, until } : null
}

/** Is this device one the studio's automation names? */
const isListed = (config, device) => config.device_names.includes(device.device_name)

/**
 * The cast URL for the device's display, null unless the display is found,
 * active and at the device's studio.
 * @returns {Promise<{ castUrl: string|null, error: boolean }>}
 */
async function readCastUrl(db, device) {
  if (!device.tv_display_id) return { castUrl: null, error: false }
  const { data, error } = await db
    .from('tv_displays')
    .select('id, token, active, location_id')
    .eq('id', device.tv_display_id)
    .eq('location_id', device.location_id)
    .maybeSingle()
  if (error) {
    logWarn(LOG, 'tv display unreadable; no cast url', {
      deviceName: device.device_name, displayId: device.tv_display_id, error: error.message,
    })
    return { castUrl: null, error: true }
  }
  if (!data || !data.active || !data.token || data.location_id !== device.location_id) {
    return { castUrl: null, error: false }
  }
  return { castUrl: `${getAppUrl()}/tv/cast/${data.token}?kiosk=1`, error: false }
}

/**
 * Assemble one box's plan.
 *
 * Read order: automation row, then (when enabled and the device is listed) the
 * studio zone and occurrences, then the display. The display is read even for
 * a disabled automation (marketing still needs the cast URL).
 *
 * @param {object} db service-role client
 * @param {{ device_name: string, role?: string, location_id: string, tv_display_id: string|null, override_mode: string|null, override_until: string|null }} device
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{
 *   ok: true, server_now: string, generated_at: string, timezone: string|null,
 *   poll_seconds: number, class_app_package: string|null, cast_url: string|null,
 *   stale_plan_mode: 'class_app'|'marketing', override: { mode: string, until: string }|null,
 *   windows: Array, degraded?: 'zone_unreadable'|'automation_unreadable'|'occurrences_unreadable'|'display_unreadable',
 * }>}
 */
export async function buildScreenPlan(db, device, { nowMs = Date.now() } = {}) {
  const nowIso = new Date(nowMs).toISOString()
  let degraded = null
  const degrade = (reason) => { degraded = degraded || reason }

  let windows = []
  let timezone = null
  let classAppPackage = null
  let stalePlanMode = resolveScreenConfig(null).stale_plan_mode

  const automation = await readAutomation(db, device.location_id)
  if (automation.error) degrade('automation_unreadable')
  if (automation.row) {
    const config = resolveScreenConfig(automation.row.config)
    classAppPackage = config.class_app_package
    stalePlanMode = config.stale_plan_mode
    if (automation.row.enabled === true && isListed(config, device)) {
      const planned = await planStudioWindows(db, device.location_id, config, nowMs)
      windows = planned.windows
      timezone = planned.timezone
      if (planned.degraded) degrade(planned.degraded)
    }
  }

  const display = await readCastUrl(db, device)
  if (display.error) degrade('display_unreadable')

  const plan = {
    ok: true,
    server_now: nowIso,
    generated_at: nowIso,
    timezone,
    poll_seconds: PLAN_POLL_SECONDS,
    class_app_package: classAppPackage,
    cast_url: display.castUrl,
    stale_plan_mode: stalePlanMode,
    override: liveOverride(device, nowMs),
    windows,
  }
  if (degraded) plan.degraded = degraded
  return plan
}

/**
 * What mode each device should be in right now, for the fleet page: one
 * automation read per distinct studio, and (when it is enabled) one zone and
 * one occurrences read. A device the automation does not list can never be in
 * a window, so it answers 'marketing' (or its own live override). `null`
 * means "no expectation": a studio whose automation is absent or disabled, or
 * whose reads failed (never a guess).
 *
 * @param {object} db service-role client
 * @param {Array<{ device_name: string, location_id: string, override_mode?: string|null, override_until?: string|null }>} devices
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<Map<string, 'class_app'|'marketing'|null>>} device_name -> mode
 */
export async function expectedModesFor(db, devices, { nowMs = Date.now() } = {}) {
  const byStudio = new Map()
  for (const device of devices || []) {
    if (!byStudio.has(device.location_id)) byStudio.set(device.location_id, [])
    byStudio.get(device.location_id).push(device)
  }

  const modes = new Map()
  for (const [locationId, studioDevices] of byStudio) {
    let windows = null // null = no expectation for this studio
    let config = null

    const automation = await readAutomation(db, locationId)
    if (automation.row && automation.row.enabled === true) {
      config = resolveScreenConfig(automation.row.config)
      const planned = await planStudioWindows(db, locationId, config, nowMs)
      if (!planned.degraded) windows = planned.windows
    }

    for (const device of studioDevices) {
      modes.set(
        device.device_name,
        windows === null
          ? null
          : modeAt(
              { windows: isListed(config, device) ? windows : [], override: liveOverride(device, nowMs) },
              nowMs,
            ),
      )
    }
  }
  return modes
}
