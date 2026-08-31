// STUDIO-AC-DEVICES.1 — unified dispatcher for AC operations.
//
// One choke-point through which every AC turn-on / turn-off / extend
// / state-read flows. Centralising here means three things can never
// be accidentally skipped:
//
//   1. The per-device permission gate — master bypasses; everyone else
//      resolves through resolveAcAllowlist (AC-ROLE.1): per-user override
//      (profile_locations.ac_device_ids) → role template
//      (location_role_permissions.ac_device_ids) → code default
//      (manager/owner = all devices, others = none).
//   2. The vendor dispatch — Sensibo vs ThinQ pick happens here, not
//      in each route, so a typo in one route can't silently route to
//      the wrong vendor.
//   3. The audit log — every state change writes an audit_events row
//      with the right category + action + target + details.
//
// Vendor adapters are injected (DEFAULT_ADAPTERS at the bottom) so
// tests can swap them out without touching the live vendor HTTP
// libs. The adapters are intentionally thin — they just expose the
// minimal {buildTurnOnState, setState, turnOff, getState} contract
// the dispatcher uses.
//
// Phase 1 (this PR): no routes call this yet. Phase 2 swaps the
// existing /api/studio-management/ac/* routes onto these functions.

import { logAuditEvent } from '@/lib/audit'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import { overlayConnections } from '@/lib/connection-registry'
import * as sensibo from '@/lib/sensibo'
import * as thinq from '@/lib/thinq'
import { resolveAcAllowlist, isAcDeviceAllowed } from '@shared/permissions'

// ============================================================
// Public API — each function returns either
//   { ok: true, ... }
// or
//   { ok: false, status: <http-status>, error, code }
// so callers can pass the shape straight through to NextResponse.
// ============================================================

/**
 * The vendor-specific "off" state for a device, built from its own
 * stored defaults. Sensibo uses it to turn off in a single POST;
 * adapters without a buildOffState (ThinQ) get undefined and ignore
 * the argument.
 */
function offStateFor(adapter, device) {
  return adapter.buildOffState?.({
    mode: device.default_mode,
    temp: device.default_temp_c,
    tempC: device.default_temp_c,
    fan: device.default_fan,
  })
}

/**
 * SENSIBO-RATE.1 — record the last observed vendor state for a device.
 *
 * Best-effort and deliberately silent: this is a cache, and failing
 * to update it must never fail the AC operation the user actually
 * asked for. A missed write just means the panel shows a slightly
 * older reading until the next ac-external-rule tick.
 *
 * Written from every place we learn a device's real state — the
 * external-rule poll, and every CRM-initiated power change — so the
 * panel's 30s poll can read the DB instead of the vendor.
 */
export async function cacheDeviceState(db, deviceId, state) {
  if (!db || !deviceId || state == null) return
  try {
    await db
      .from('ac_devices')
      .update({ last_state: state, last_state_at: new Date().toISOString() })
      .eq('id', deviceId)
  } catch { /* cache write — never surfaced */ }
}

/**
 * Load and authorise a device for the calling user.
 *
 * On success: { ok: true, device, location, role }.
 * On failure: { ok: false, status, error, code } with a status
 * suitable for HTTP (403/404/etc.).
 */
export async function loadDeviceForUser(deviceId, { user, db } = {}) {
  if (!deviceId) {
    return { ok: false, status: 400, error: 'device_id is required.', code: 'missing_device_id' }
  }
  if (!user || !db) {
    return { ok: false, status: 500, error: 'Internal: missing user or db context.', code: 'bad_context' }
  }

  const { data: device } = await db
    .from('ac_devices')
    .select('id, location_id, label, provider, provider_device_id, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, last_state, last_state_at')
    .eq('id', deviceId)
    .single()
  if (!device) {
    return { ok: false, status: 404, error: 'AC device not found.', code: 'device_not_found' }
  }
  if (!device.enabled) {
    return { ok: false, status: 409, error: 'AC device is disabled.', code: 'device_disabled' }
  }

  // Pull the location row + the user's profile_locations row in
  // parallel. Both are small targeted lookups.
  const [locRes, plRes] = await Promise.all([
    db.from('locations')
      .select('id, name, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, thinq_country_code')
      .eq('id', device.location_id)
      .single(),
    db.from('profile_locations')
      .select('role, ac_device_ids')
      .eq('profile_id', user.id)
      .eq('location_id', device.location_id)
      .maybeSingle(),
  ])
  // INTEG-A2 dual-read: registry rows (sensibo/thinq) replace the
  // legacy location columns when present; no row → legacy unchanged.
  const location = locRes.data
    ? await overlayConnections(db, locRes.data, ['sensibo', 'thinq'])
    : null
  const assignment = plRes.data || null
  if (!location) {
    return { ok: false, status: 404, error: 'Location for AC device not found.', code: 'location_not_found' }
  }

  const auth = authoriseDevice({
    user,
    assignment,
    deviceId: device.id,
    templateList: user?.acDeviceTemplatesByLocation?.[device.location_id] ?? null,
  })
  if (!auth.ok) return auth

  return { ok: true, device, location, role: auth.role }
}

/**
 * Read current device state via the appropriate vendor.
 */
export async function getState(deviceId, ctx) {
  const loaded = await loadDeviceForUser(deviceId, ctx)
  if (!loaded.ok) return loaded
  const { device, location } = loaded

  const adapter = pickAdapter(device.provider, ctx)
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error

  try {
    const state = await adapter.adapter.getState(device.provider_device_id, creds.creds)
    // A live read is the freshest truth we'll get — bank it so the
    // panel's next poll can be served from the DB.
    await cacheDeviceState(ctx.db, device.id, state)
    return { ok: true, state, device }
  } catch (e) {
    return vendorError(e)
  }
}

/**
 * Turn the device on. Applies the device's per-device defaults +
 * starts a session row with auto_off_at = now + session_minutes.
 *
 * 409 if a session for this device is already active — same
 * semantics as the existing /api/studio-management/ac/turn-on
 * route. We return the existing session so the caller can show a
 * "still running" message without resetting the timer.
 */
export async function turnOn(deviceId, ctx) {
  const loaded = await loadDeviceForUser(deviceId, ctx)
  if (!loaded.ok) return loaded
  const { device, location } = loaded
  const { db, user, request } = ctx

  // Already-running guard. Per-device, not per-location, so a
  // staffer who turns on Bathroom-M doesn't block their colleague
  // from turning on Bathroom-F.
  const { data: openRows } = await db
    .from('ac_sessions')
    .select('id, started_at, auto_off_at, status, started_by, profiles:started_by(full_name)')
    .eq('device_id', device.id)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
  const existing = openRows?.[0]
  if (existing) {
    const minsLeft = existing.auto_off_at
      ? Math.max(0, Math.round((new Date(existing.auto_off_at).getTime() - Date.now()) / 60000))
      : null
    return {
      ok: false,
      status: 409,
      code: 'already_running',
      error: `${device.label} is already on` +
        (existing.profiles?.full_name ? ` (started by ${existing.profiles.full_name})` : '') +
        (minsLeft != null ? ` — ${minsLeft} min remaining.` : '.'),
      session: existing,
    }
  }

  const adapter = pickAdapter(device.provider, ctx)
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error

  const body = adapter.adapter.buildTurnOnState({
    mode: device.default_mode,
    tempC: device.default_temp_c,
    temp: device.default_temp_c,        // Sensibo's buildTurnOnState uses `temp`
    fan: device.default_fan,
  })
  const minutes = device.session_minutes || 30
  const autoOffAt = new Date(Date.now() + minutes * 60_000).toISOString()

  // Push to the vendor first. Only write the session row if the
  // vendor accepts — keeps rollback clean if anything fails.
  let observed
  try {
    observed = await adapter.adapter.setState(device.provider_device_id, body, creds.creds)
  } catch (e) {
    return vendorError(e)
  }

  // For Sensibo devices the legacy state route still reads
  // ac_sessions.sensibo_pod_id, so populate it. ThinQ devices
  // leave the column NULL.
  const sensiboPodId = device.provider === 'sensibo' ? device.provider_device_id : null

  const { data: session, error: insErr } = await db
    .from('ac_sessions')
    .insert({
      location_id: device.location_id,
      device_id: device.id,
      sensibo_pod_id: sensiboPodId,
      started_by: user.id,
      auto_off_at: autoOffAt,
      status: AC_SESSION_STATUS.ON,
      sensibo_state_snapshot: observed,
    })
    .select()
    .single()

  if (insErr) {
    // Roll back the vendor turn-on best-effort. Worst case the
    // auto-off cron picks it up at the configured session_minutes.
    try {
      await adapter.adapter.turnOff(
        device.provider_device_id, creds.creds, offStateFor(adapter.adapter, device))
    } catch { /* best-effort */ }
    return { ok: false, status: 500, error: insErr.message, code: 'session_insert_failed' }
  }

  // Panel reads state from the DB now, so reflect the change we just
  // made immediately rather than waiting for the next cron poll.
  await cacheDeviceState(db, device.id, observed)

  await logAuditEvent({
    category: 'business',
    action: 'ac.turn_on',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: device.label, resource: `ac_device/${device.id}` },
    locationId: device.location_id,
    details: {
      provider: device.provider,
      mode: device.default_mode,
      temp_c: device.default_temp_c,
      fan: device.default_fan,
      session_minutes: minutes,
      auto_off_at: autoOffAt,
    },
    request,
  })

  return { ok: true, session, device }
}

/**
 * Turn the device off. Marks any active session as manual_off and
 * pushes the vendor power-off. Safe to call when no session is
 * active (no-ops the session update, still pushes vendor off).
 */
export async function turnOff(deviceId, ctx) {
  const loaded = await loadDeviceForUser(deviceId, ctx)
  if (!loaded.ok) return loaded
  const { device, location } = loaded
  const { db, user, request } = ctx

  const adapter = pickAdapter(device.provider, ctx)
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error

  try {
    await adapter.adapter.turnOff(
      device.provider_device_id, creds.creds, offStateFor(adapter.adapter, device))
  } catch (e) {
    return vendorError(e)
  }

  const nowIso = new Date().toISOString()
  const { data: closed } = await db
    .from('ac_sessions')
    .update({
      status: AC_SESSION_STATUS.MANUAL_OFF,
      ended_at: nowIso,
      ended_by: user.id,
    })
    .eq('device_id', device.id)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .select()

  // Same as turn-on: record the state we just commanded. Cheaper and
  // more immediate than a read-back, and the external-rule cron
  // reconciles it against reality on its next tick anyway.
  await cacheDeviceState(db, device.id, { ...(device.last_state || {}), on: false })

  await logAuditEvent({
    category: 'business',
    action: 'ac.turn_off',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: device.label, resource: `ac_device/${device.id}` },
    locationId: device.location_id,
    details: { provider: device.provider, sessions_closed: closed?.length || 0 },
    request,
  })

  return { ok: true, sessions_closed: closed?.length || 0, device }
}

/**
 * Extend the active session's auto-off timer by the device's
 * session_minutes. No-ops if no session is active.
 */
export async function extendSession(deviceId, ctx) {
  const loaded = await loadDeviceForUser(deviceId, ctx)
  if (!loaded.ok) return loaded
  const { device } = loaded
  const { db, user, request } = ctx

  const { data: openRows } = await db
    .from('ac_sessions')
    .select('id, auto_off_at, status')
    .eq('device_id', device.id)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
  const existing = openRows?.[0]
  if (!existing) {
    return { ok: false, status: 409, code: 'no_active_session',
             error: `${device.label} is not currently on.` }
  }

  const minutes = device.session_minutes || 30
  const base = existing.auto_off_at ? new Date(existing.auto_off_at).getTime() : Date.now()
  const next = new Date(Math.max(base, Date.now()) + minutes * 60_000).toISOString()

  const { data: updated, error: updErr } = await db
    .from('ac_sessions')
    .update({ auto_off_at: next, status: AC_SESSION_STATUS.EXTENDED })
    .eq('id', existing.id)
    .select()
    .single()
  if (updErr) {
    return { ok: false, status: 500, error: updErr.message, code: 'session_update_failed' }
  }

  await logAuditEvent({
    category: 'business',
    action: 'ac.extend',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: device.label, resource: `ac_device/${device.id}` },
    locationId: device.location_id,
    details: { provider: device.provider, added_minutes: minutes, auto_off_at: next },
    request,
  })

  return { ok: true, session: updated, device }
}

// ============================================================
// Authorisation
// ============================================================

/**
 * Decide whether `user` may operate on device `deviceId` at the
 * device's location. Returns { ok: true, role } when allowed, or
 * the 403-shape error otherwise.
 *
 * Rules (mirrors UniFi-doors model from mig 182):
 *   - Master role: always allowed.
 *   - User must have a profile_locations row at this location.
 *     No row → 403 (user isn't assigned to this location).
 *   - Per-location role = assignment.role ?? user.profileRole.
 *   - Else: resolved through resolveAcAllowlist — per-user override
 *     (assignment.ac_device_ids) → role template (templateList) →
 *     code default (manager/owner = all, everyone else = none).
 */
export function authoriseDevice({ user, assignment, deviceId, templateList = null }) {
  if (user?.role === 'master') return { ok: true, role: 'master' }

  if (!assignment) {
    return {
      ok: false,
      status: 403,
      code: 'not_assigned_to_location',
      error: 'You are not assigned to this location.',
    }
  }

  const role = assignment.role || user?.profileRole || user?.role || null
  // AC-ROLE.1 — resolve through per-user override → role template →
  // code default (manager/owner = all). Replaces the old inline
  // "NULL + manager/owner ⇒ all" special-case.
  const resolved = resolveAcAllowlist({ role, userList: assignment.ac_device_ids ?? null, templateList })
  if (isAcDeviceAllowed(resolved, deviceId)) {
    return { ok: true, role }
  }

  return {
    ok: false,
    status: 403,
    code: 'device_not_in_allowlist',
    error: 'You are not authorised to control this AC unit. Ask an admin to add it to your access list.',
  }
}

// ============================================================
// Cron + bookkeeping helpers
// ============================================================

/**
 * Look up the joined device + location row by device id, with no
 * permission check. Intended for the auto-off cron (system actor,
 * no user). User-facing routes should still go through
 * loadDeviceForUser so the allowlist gate runs.
 */
export async function loadDeviceWithLocation(deviceId, db) {
  if (!deviceId) return { ok: false, status: 400, error: 'device_id is required.', code: 'missing_device_id' }
  const { data: device } = await db
    .from('ac_devices')
    .select('id, location_id, label, provider, provider_device_id, default_mode, default_temp_c, default_fan, session_minutes, enabled, last_state, last_state_at')
    .eq('id', deviceId)
    .single()
  if (!device) return { ok: false, status: 404, error: 'AC device not found.', code: 'device_not_found' }

  const { data: locationRow } = await db
    .from('locations')
    .select('id, name, organization_id, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, thinq_country_code')
    .eq('id', device.location_id)
    .single()
  if (!locationRow) return { ok: false, status: 404, error: 'Location for AC device not found.', code: 'location_not_found' }
  // INTEG-A2 dual-read overlay (see loadDeviceForUser).
  const location = await overlayConnections(db, locationRow, ['sensibo', 'thinq'])

  return { ok: true, device, location }
}

/**
 * Pure vendor power-off — dispatches to the right adapter based on
 * device.provider with no DB writes, no permission check, no audit.
 * The auto-off cron uses this so it can write its own AUTO_OFF
 * session row (rather than the dispatcher's MANUAL_OFF default).
 */
export async function vendorTurnOff(device, location, { vendorAdapters } = {}) {
  const adapter = pickAdapter(device.provider, { vendorAdapters })
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error
  try {
    await adapter.adapter.turnOff(
      device.provider_device_id, creds.creds, offStateFor(adapter.adapter, device))
    return { ok: true }
  } catch (e) {
    return vendorError(e)
  }
}

/**
 * Pure vendor power-ON — dispatches to the right adapter using the
 * device's stored defaults (mode/temp/fan), with no permission check, no
 * session write, no audit. The schedule-driven crons (class-climate) use
 * this so they can write their OWN system ac_sessions row (started_by
 * NULL) with a class-aligned auto_off_at. Symmetric with vendorTurnOff.
 *
 * Requires the device row to carry default_mode/default_temp_c/default_fan
 * (loadDeviceWithLocation selects them). Returns { ok: true, observed }
 * (observed = vendor's post-set state) or { ok: false, error, status?, code? }.
 */
export async function vendorTurnOn(device, location, { vendorAdapters } = {}) {
  const adapter = pickAdapter(device.provider, { vendorAdapters })
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error
  const body = adapter.adapter.buildTurnOnState({
    mode: device.default_mode,
    tempC: device.default_temp_c,
    temp: device.default_temp_c, // Sensibo's buildTurnOnState uses `temp`
    fan: device.default_fan,
  })
  try {
    const observed = await adapter.adapter.setState(device.provider_device_id, body, creds.creds)
    return { ok: true, observed }
  } catch (e) {
    return vendorError(e)
  }
}

/**
 * Pure vendor state read — dispatches to the right adapter with no
 * permission check. Used by the ac-external-rule cron, which needs
 * to poll every enabled device on every tick to detect units that
 * were started outside the CRM (LG remote, Sensibo app, wall
 * panel). Symmetric with vendorTurnOff above.
 *
 * Returns { ok: true, state } on success — same shape as the
 * dispatcher's getState() — or { ok: false, error, status?, code? }
 * if anything goes wrong (creds missing, vendor down, etc.).
 */
export async function vendorGetState(device, location, { vendorAdapters } = {}) {
  const adapter = pickAdapter(device.provider, { vendorAdapters })
  if (adapter.error) return adapter.error
  const creds = resolveCredentials(device, location)
  if (creds.error) return creds.error
  try {
    const state = await adapter.adapter.getState(device.provider_device_id, creds.creds)
    return { ok: true, state }
  } catch (e) {
    return vendorError(e)
  }
}

/**
 * Find the first enabled AC device at a location, in stable order.
 * Backward-compat shim for legacy callers that operate on the
 * implicit "the location's AC" (pre-multi-device era). Returns
 * `null` if no enabled device exists for the location.
 */
export async function findDefaultDeviceForLocation(locationId, db) {
  if (!locationId) return null
  const { data: row } = await db
    .from('ac_devices')
    .select('id, location_id, label, provider, provider_device_id, default_mode, default_temp_c, default_fan, session_minutes, enabled, last_state, last_state_at')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return row || null
}

// ============================================================
// Vendor dispatch
// ============================================================

function pickAdapter(provider, ctx = {}) {
  const adapters = ctx.vendorAdapters || DEFAULT_ADAPTERS
  const adapter = adapters[provider]
  if (!adapter) {
    return { error: {
      ok: false, status: 500, code: 'unknown_provider',
      error: `Unknown AC provider: ${provider}.`,
    }}
  }
  return { adapter }
}

function resolveCredentials(device, location) {
  if (device.provider === 'sensibo') {
    if (!location.sensibo_api_key) {
      return { error: {
        ok: false, status: 412, code: 'sensibo_not_configured',
        error: 'Sensibo API key is not set for this location.',
      }}
    }
    return { creds: { apiKey: location.sensibo_api_key } }
  }
  if (device.provider === 'thinq') {
    if (!location.thinq_pat || !location.thinq_client_id) {
      return { error: {
        ok: false, status: 412, code: 'thinq_not_configured',
        error: 'LG ThinQ credentials are not set for this location.',
      }}
    }
    return {
      creds: {
        pat: location.thinq_pat,
        clientId: location.thinq_client_id,
        countryCode: location.thinq_country_code || 'IE',
      },
    }
  }
  return { error: {
    ok: false, status: 500, code: 'unknown_provider',
    error: `Unknown AC provider: ${device.provider}.`,
  }}
}

function vendorError(e) {
  const msg = e?.message || String(e)
  return {
    ok: false,
    status: 502,
    code: 'vendor_error',
    error: `AC vendor refused the request: ${msg}`,
  }
}

// ============================================================
// Default adapters wired to the live HTTP libs. Tests inject
// their own via ctx.vendorAdapters.
// ============================================================

const sensiboAdapter = {
  buildTurnOnState: ({ mode, temp, fan }) => sensibo.buildTurnOnState({ mode, temp, fan }),
  // SENSIBO-RATE.1 — supplying the off state lets turnPodOff skip its
  // state read, making power-off ONE call instead of two.
  buildOffState: ({ mode, temp, fan }) => sensibo.buildTurnOffState({ mode, temp, fan }),
  setState: (podId, body, { apiKey }) => sensibo.setPodState(apiKey, podId, body),
  turnOff:  (podId, { apiKey }, offState) => sensibo.turnPodOff(apiKey, podId, offState),
  getState: (podId, { apiKey }) => sensibo.getPodState(apiKey, podId),
}

const thinqAdapter = {
  buildTurnOnState: ({ mode, tempC, fan }) => thinq.buildTurnOnState({ mode, tempC, fan }),
  // ThinQ's turnOff is already a single command and needs no desired
  // state, so it has no buildOffState and ignores the extra arg.
  setState: (deviceId, body, creds) => thinq.setDeviceState(deviceId, body, creds),
  turnOff:  (deviceId, creds) => thinq.turnOff(deviceId, creds),
  getState: (deviceId, creds) => thinq.getDeviceState(deviceId, creds),
}

export const DEFAULT_ADAPTERS = Object.freeze({
  sensibo: sensiboAdapter,
  thinq:   thinqAdapter,
})
