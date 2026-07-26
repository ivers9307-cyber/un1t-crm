// BATHROOM-CLIMATE.1 — runtime for the bathroom-climate automation. Shared
// by the cron (/api/cron/bathroom-climate) and the operator "Run check
// now" button (/api/automations/bathroom_climate/run-now).
//
// For each location with the automation enabled, turn the configured
// bathroom AC unit(s) ON for any class whose post-start window
// (start + delay .. + duration) is open and which hasn't been actioned
// yet — by writing a system ac_sessions row (started_by NULL) with
// auto_off_at anchored to the class schedule. The existing ac-auto-off
// cron performs the OFF; the external-rule cron sees the active session
// and leaves the unit alone. Idempotency + run history via
// automation_fire_log (keyed bathroom_climate, so the gym floor's
// class_climate history never crosses).

import { vendorTurnOn, loadDeviceWithLocation } from '@/lib/ac-devices'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'
import { resolveConfig, planBathroomClimate, autoOffAtFor } from '@/lib/bathroom-climate'

export const AUTOMATION_KEY = 'bathroom_climate'
const OCCURRENCE_LOOKAHEAD_MS = 6 * 60 * 60_000 // classes within the next 6h
// Lookback floor is 2h (not class-climate's 1h): a window opens up to
// delay_after_start_min AFTER a class starts, so a 1h lookback would miss
// e.g. a 06:00 class when the cron ticks at 07:10 with delay 65. It's only
// a floor — an oversized operator delay/duration derives a larger lookback
// below so the class never outruns the occurrence query.
const OCCURRENCE_LOOKBACK_MS = 2 * 60 * 60_000

/**
 * Run the automation for one location's config row.
 * @param {object} db
 * @param {{ location_id: string, config: object }} automationRow
 * @param {{ nowMs?: number, dryRun?: boolean }} opts
 */
export async function runBathroomClimateForLocation(db, automationRow, { nowMs = Date.now(), dryRun = false } = {}) {
  const locationId = automationRow.location_id
  const config = resolveConfig(automationRow.config)
  const result = { location_id: locationId, planned: [], actions: [], errors: [] }

  if (config.device_ids.length === 0) {
    result.errors.push('no_devices_configured')
    return result
  }

  // Lookback must cover the whole window: a class can still need firing up
  // to delay+duration after it starts. The 2h floor keeps the query bounded
  // for sane configs; the derived term covers oversized operator values.
  const lookbackMs = Math.max(
    OCCURRENCE_LOOKBACK_MS,
    (config.delay_after_start_min + config.run_duration_min + 10) * 60_000,
  )
  const sinceIso = new Date(nowMs - lookbackMs).toISOString()
  const untilIso = new Date(nowMs + OCCURRENCE_LOOKAHEAD_MS).toISOString()
  const { data: occurrences, error: occErr } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
    .is('cancelled_at', null) // never fire for a cancelled class
    .order('starts_at', { ascending: true })
  if (occErr) {
    result.errors.push(`occurrences_read_failed: ${occErr.message}`)
    return result
  }

  const planned = planBathroomClimate({ occurrences: occurrences || [], config, nowMs })
  result.planned = planned.map((p) => ({
    glofox_event_id: p.glofox_event_id, name: p.occurrence.name, starts_at: p.occurrence.starts_at,
  }))
  if (planned.length === 0) return result

  // What's already been turned on (idempotency)? Only a successful 'fired'
  // row blocks a re-attempt; 'skipped'/'failed' rows get retried (and the
  // upsert updates them in place).
  const eventIds = planned.map((p) => p.glofox_event_id)
  const { data: firedRows } = await db
    .from('automation_fire_log')
    .select('glofox_event_id, device_id, status')
    .eq('automation_key', AUTOMATION_KEY)
    .eq('action_step', 'on')
    .in('glofox_event_id', eventIds)
  const firedSet = new Set(
    (firedRows || []).filter((r) => r.status === 'fired').map((r) => `${r.glofox_event_id}:${r.device_id}`),
  )

  for (const p of planned) {
    for (const deviceId of config.device_ids) {
      if (firedSet.has(`${p.glofox_event_id}:${deviceId}`)) continue

      const action = { glofox_event_id: p.glofox_event_id, class_name: p.occurrence.name, device_id: deviceId }
      if (dryRun) {
        action.status = 'would_fire'
        result.actions.push(action)
        continue
      }
      const out = await fireOn(db, { locationId, deviceId, occurrence: p.occurrence, config, nowMs })
      action.status = out.status
      if (out.error) action.error = out.error
      result.actions.push(action)
    }
  }

  return result
}

/**
 * Turn one device on for one occurrence + record it. Idempotent at the
 * fire-log layer; compatible with the existing AC crons (writes a system
 * ac_sessions row with a schedule-anchored auto_off_at).
 */
async function fireOn(db, { locationId, deviceId, occurrence, config, nowMs }) {
  const eventId = occurrence.glofox_event_id
  const loaded = await loadDeviceWithLocation(deviceId, db)
  if (!loaded.ok) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'device_load_failed', error: loaded.error } })
    return { status: 'failed', error: loaded.error }
  }
  const { device, location } = loaded

  // Already on (operator, the gym automation, or an overlapping window)?
  // Don't double-fire the vendor; record skipped so the timeline shows it
  // (and it gets re-evaluated next tick once the prior session ends).
  const { data: activeRows } = await db
    .from('ac_sessions')
    .select('id')
    .eq('device_id', deviceId)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .limit(1)
  if ((activeRows?.length || 0) > 0) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'skipped', detail: { reason: 'already_on' } })
    return { status: 'skipped' }
  }

  const turned = await vendorTurnOn(device, location)
  if (!turned.ok) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'vendor_error', error: turned.error } })
    return { status: 'failed', error: turned.error }
  }

  const autoOffAt = autoOffAtFor(occurrence, config, nowMs)
  const { error: insErr } = await db
    .from('ac_sessions')
    .insert({
      location_id: locationId,
      device_id: deviceId,
      sensibo_pod_id: device.provider === 'sensibo' ? device.provider_device_id : null,
      started_by: null, // system actor
      auto_off_at: autoOffAt,
      status: AC_SESSION_STATUS.ON,
      sensibo_state_snapshot: turned.observed ?? null,
    })
  if (insErr) {
    // Vendor is on but we couldn't record the session. The external-rule
    // cron will cap it; record the fire as failed so a human can notice.
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'session_insert_failed', error: insErr.message } })
    return { status: 'failed', error: insErr.message }
  }

  await logAuditEvent({
    category: 'business',
    action: 'ac.bathroom_auto_on',
    // No target.id: it maps to audit_events.target_profile_id (FK →
    // profiles), so a device UUID there kills the insert. The device
    // identity rides in target.resource.
    target: { label: device.label, resource: `ac_device/${deviceId}` },
    locationId,
    details: { automation: AUTOMATION_KEY, glofox_event_id: eventId, class_name: occurrence.name, auto_off_at: autoOffAt },
  }).catch(() => {})

  await recordFire(db, { locationId, eventId, deviceId, status: 'fired', detail: { class_name: occurrence.name, auto_off_at: autoOffAt } })
  return { status: 'fired' }
}

async function recordFire(db, { locationId, eventId, deviceId, status, detail }) {
  const { error } = await db
    .from('automation_fire_log')
    .upsert({
      location_id: locationId,
      automation_key: AUTOMATION_KEY,
      glofox_event_id: eventId,
      device_id: deviceId,
      action_step: 'on',
      status,
      detail: detail || null,
      fired_at: new Date().toISOString(),
    }, { onConflict: 'automation_key,glofox_event_id,device_id,action_step' })
  if (error) logWarn('bathroom-climate', 'fire-log write failed', { eventId, deviceId, error: error.message })
}

/**
 * Run for every location that has bathroom_climate enabled (the cron
 * path), or a single location (the run-now path when locationId is given).
 * @param {object} db
 * @param {{ nowMs?: number, dryRun?: boolean, locationId?: string|null }} opts
 */
export async function runBathroomClimate(db, { nowMs = Date.now(), dryRun = false, locationId = null } = {}) {
  let q = db
    .from('location_automations')
    .select('location_id, config, enabled')
    .eq('automation_key', AUTOMATION_KEY)
    .eq('enabled', true)
  if (locationId) q = q.eq('location_id', locationId)
  const { data: rows, error } = await q
  if (error) return { ok: false, error: error.message, locations: [] }

  const locations = []
  for (const row of rows || []) {
    locations.push(await runBathroomClimateForLocation(db, row, { nowMs, dryRun }))
  }
  return { ok: true, locations }
}
