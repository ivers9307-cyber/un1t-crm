// HOMEYD.3 — reconcile runner + state-report port for the direct-control
// cron (see docs/superpowers/specs/2026-08-01-homey-direct-control-design.md).
//
// reportDeviceStates ports src/app/api/bridge/tapo/state/route.js's
// select→branch loop (TAPO-T1) behaviour-identically — that route is
// deleted in Task 5, so this comment block moves with the code, not
// just the logic.
//
// runHomeyReconcile is the per-minute cron body: one Homey GET → merge
// mapped devices+states → load enabled tapo_devices + today's
// occurrences → planCommands → fire each command → report the full
// snapshot. Deps are injectable so the cron route can call this with
// the real Homey client/db and tests can inject fakes.

import { getHomeyConfig, homeyGetDevices, homeySetOnoff } from './client.js'
import { mapHomeyDevices, mapHomeyStates, planCommands } from './devices.js'
import { dublinTodayStr, dublinDayStartMs, addDaysISO } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

const MAX_ROWS = 200

// ≤50 devices per location — the per-row loop is fine at this scale.
//
// Why select-then-branch instead of a single upsert: on conflict,
// supabase-js upsert updates EVERY supplied column, so a payload
// carrying the insert defaults (enabled=false, schedule_mode='none',
// kind, name) would stomp an adopted device's config on each report;
// a safe-columns-only payload would insert discoveries without
// kind/name_hint (the adopt-flow affordance). So we branch, check
// every error honestly, and treat an insert 23505 as the benign
// concurrent-registration race (fall back to the update path so the
// report isn't dropped).
export async function reportDeviceStates(db, locationId, rows) {
  const nowIso = new Date().toISOString()
  let updated = 0
  let discovered = 0
  let failed = 0

  // Cap defensively — the bridge route enforced this via its Zod schema
  // (`.max(200)`); this path has no request boundary to validate at, so
  // slice instead of trusting the caller.
  for (const d of (rows || []).slice(0, MAX_ROWS)) {
    const patch = { last_state: d.state, updated_at: nowIso }
    if (d.reachable !== false) patch.last_seen_at = nowIso

    const { data: existing, error: selErr } = await db.from('tapo_devices')
      .select('id').eq('location_id', locationId)
      .eq('sidecar_device_id', d.sidecar_device_id).maybeSingle()
    if (selErr) {
      // A transient read failure must NOT fall through to the insert
      // branch (it would 23505 against a row that exists).
      logWarn('homey-reconcile', 'device lookup failed', {
        sidecarDeviceId: d.sidecar_device_id, err: selErr.message,
      })
      failed++
      continue
    }

    if (existing) {
      const { error: updErr } = await db.from('tapo_devices').update(patch).eq('id', existing.id)
      if (updErr) {
        logWarn('homey-reconcile', 'state update failed', {
          sidecarDeviceId: d.sidecar_device_id, err: updErr.message,
        })
        failed++
      } else {
        updated++
      }
      continue
    }

    const { error: insErr } = await db.from('tapo_devices').insert({
      location_id: locationId,
      sidecar_device_id: d.sidecar_device_id,
      kind: d.kind || 'plug',
      name: d.name_hint || null,
      enabled: false,
      schedule_mode: 'none',
      last_state: d.state,
      last_seen_at: nowIso,
      updated_at: nowIso,
    })
    if (!insErr) {
      discovered++
    } else if (insErr.code === '23505') {
      // Benign race on UNIQUE(location_id, sidecar_device_id): a
      // concurrent report registered this device between our select and
      // insert. Apply the state patch instead.
      const { error: raceUpdErr } = await db.from('tapo_devices').update(patch)
        .eq('location_id', locationId).eq('sidecar_device_id', d.sidecar_device_id)
      if (raceUpdErr) {
        logWarn('homey-reconcile', 'post-race state update failed', {
          sidecarDeviceId: d.sidecar_device_id, err: raceUpdErr.message,
        })
        failed++
      } else {
        updated++
      }
    } else {
      logWarn('homey-reconcile', 'device auto-register failed', {
        sidecarDeviceId: d.sidecar_device_id, err: insErr.message,
      })
      failed++
    }
  }

  return { updated, discovered, failed }
}

export async function runHomeyReconcile(db, deps = {}) {
  const getConfig = deps.getConfig || getHomeyConfig
  const getDevices = deps.getDevices || homeyGetDevices
  const setOnoff = deps.setOnoff || homeySetOnoff
  const now = deps.now || Date.now

  const cfg = getConfig()
  // Fully unset — dormant, not yet turned on for this deploy. No logging:
  // every Vercel deploy runs this cron before an operator sets the env vars.
  if (cfg === null) return { skipped: true, reason: 'unconfigured' }
  if (cfg.error) {
    logWarn('homey-reconcile', 'misconfigured', { error: cfg.error })
    return { skipped: true, reason: 'misconfigured' }
  }

  const devicesRes = await getDevices(cfg)
  if (!devicesRes.ok) {
    // statusCode 401 = bad/rotated key; 0 = network/timeout/DNS. Either
    // way: zero state reports this minute is the alert — last_seen_at
    // staleness drives the existing amber/red dots — not a thrown error;
    // no DB writes happen this tick.
    logWarn('homey-reconcile', 'homey unreachable', { statusCode: devicesRes.statusCode })
    return { ok: true, homeyDown: true }
  }

  const mappedDevices = mapHomeyDevices(devicesRes.body)
  const mappedStates = mapHomeyStates(devicesRes.body)

  // Merge into report rows keyed by sidecar_device_id: state+reachable
  // come from the states mapper, kind+name_hint from the devices mapper
  // (same underlying Homey payload, so the key sets match).
  const merged = new Map()
  for (const s of mappedStates) {
    merged.set(s.sidecar_device_id, { sidecar_device_id: s.sidecar_device_id, state: s.state, reachable: s.reachable })
  }
  for (const d of mappedDevices) {
    const row = merged.get(d.sidecar_device_id) || { sidecar_device_id: d.sidecar_device_id, state: null, reachable: undefined }
    row.kind = d.kind
    if (d.name_hint !== undefined) row.name_hint = d.name_hint
    merged.set(d.sidecar_device_id, row)
  }
  const mergedRows = Array.from(merged.values())

  const nowMs = now()
  const today = dublinTodayStr()
  const dayStart = new Date(dublinDayStartMs(today)).toISOString()
  // Today's Dublin day EXACTLY (DST-exact next-midnight bound, not a flat
  // +24h/+36h). Pulling tomorrow's occurrences in would be a real bug: class
  // mode collapses ALL occurrences into ONE window (min(starts)−lead →
  // max(ends)+lag), so tomorrow's 06:00 class would hold class-linked devices
  // ON all night, every night. Fixed windows never consume occurrences, and a
  // class STARTING today but ending after midnight still spills forward
  // correctly because off_at = ends+lag regardless of date.
  const dayEnd = new Date(dublinDayStartMs(addDaysISO(today, 1))).toISOString()

  const [{ data: deviceRows, error: devErr }, { data: occurrences, error: occErr }] = await Promise.all([
    db.from('tapo_devices').select('*').eq('location_id', cfg.locationId).eq('enabled', true).limit(200),
    db.from('class_occurrences').select('starts_at, ends_at, cancelled_at')
      .eq('location_id', cfg.locationId).gte('starts_at', dayStart).lt('starts_at', dayEnd)
      .is('cancelled_at', null).limit(500),
  ])
  if (devErr || occErr) {
    // Heartbeat still stamps at the route layer on this `ok:false` return
    // (a try/catch there, not a throw) — a transient DB blip shouldn't
    // page as a dead cron, just skip commanding/reporting for this tick.
    const err = devErr || occErr
    logWarn('homey-reconcile', 'device/occurrence load failed', { error: err.message })
    return { ok: false, error: err.message }
  }

  const commands = planCommands(deviceRows || [], mappedStates, nowMs, today, occurrences || [])

  let commanded = 0
  let commandFailures = 0
  for (const cmd of commands) {
    const res = await setOnoff(cfg, cmd.sidecar_device_id, cmd.on)
    if (res.ok) {
      commanded++
    } else {
      // Not retried inline — the next minute's tick re-diffs against
      // Homey's actual state and retries automatically (reconcile is
      // idempotent by construction).
      logWarn('homey-reconcile', 'command failed', { sidecarDeviceId: cmd.sidecar_device_id, statusCode: res.statusCode })
      commandFailures++
    }
  }

  // Report AFTER commanding: the snapshot is from the GET taken before
  // this tick's commands landed, so it won't reflect them yet — the next
  // tick's GET will. Same report→command→report lag the champ-bridge
  // cycle always had; it's fine because reconcile runs every minute.
  const reportCounters = await reportDeviceStates(db, cfg.locationId, mergedRows)

  return { ok: true, commanded, commandFailures, ...reportCounters }
}
