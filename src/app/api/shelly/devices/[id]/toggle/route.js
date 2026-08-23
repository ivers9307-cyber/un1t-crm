// SHELLY-UI.5 — the manual switch: force one relay on or off for a while, or
// hand it back to its schedule.
//
// THE WRITE ORDER IS THE CONTRACT, and it only goes one way.
//
//   1. The override is written FIRST, then the command is sent.
//      An override is INTENT. Once it is on the row, the cron applies it to
//      every adopted device, enabled or not (plan.js rule 1), so a command
//      that fails self-heals on the next tick. Send first and the operator's
//      intent lives only in a request that has already failed: a plug that was
//      briefly offline stays wrong until someone notices and presses the
//      button again.
//   2. A FAILED COMMAND IS THEREFORE NOT A FAILED REQUEST. It answers 200
//      with `applied:false, pending:true` — the honest report of what
//      happened, and what will happen. The one exception is a rate limit,
//      which is HTTP 429 so the client can back off rather than re-press;
//      the body still says `pending:true`, because it is.
//   3. A FAILED *STAMP* IS NOT A FAILED COMMAND. If setSwitch succeeded the
//      relay has physically moved, so a lost `last_applied` write is logged
//      and the response still says `applied:true`. Telling the operator the
//      switch did not happen when it did is the louder failure, and the cost
//      of the lost stamp is bounded: the next tick re-issues the same
//      idempotent command under the same key.
//   4. A FAILED *OVERRIDE* WRITE REFUSES. This is the one place that must
//      fail closed, and for a reason that is the mirror of (3): without the
//      row the cron does not know the operator wants the plug on, so it would
//      spend the rest of the day putting it back where the schedule says —
//      the machine visibly fighting the human, with a success message on
//      screen. Nothing has been sent at that point, so refusing costs a retry
//      and nothing else.
//
// TIMEZONE. `until` defaults to the LOCATION's next local midnight, and the
// engine that later expires it resolves the zone from `conn.locations`, which
// loadConnectionWithKey does not select — see withLocationTz in
// src/lib/shelly/device-load.js for why both sides must be given the same
// answer.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { createShellyClient } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { loadDevice, DEVICE_COLUMNS, requestTz, withLocationTz } from '@/lib/shelly/device-load'
import { overrideKey } from '@/lib/shelly/plan'
import { runNowForDevice } from '@/lib/shelly/reconcile'
import { ShellyToggleBody, ShellyOverride, MAX_OVERRIDE_HOURS } from '@/lib/shelly/schemas'
import { stateFromReading } from '@/lib/shelly/status'
import { nextLocalMidnightMs } from '@/lib/tz-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-toggle'
const HOUR_MS = 60 * 60 * 1000

// OUR vocabulary for a command that has not landed yet, keyed by the client's
// own failure tag. `code` is what the page branches on across the whole Shelly
// surface (`not_connected`, `key_rejected`, `disabled`…), so it stays ours;
// `kind` carries the client's tag verbatim alongside it for the logs.
const PENDING_CODE = { auth: 'key_rejected', rate_limited: 'rate_limited' }

const PENDING_MESSAGE = {
  auth: 'Saved. Shelly rejected the stored key — re-paste it from the Shelly app and the plug will follow.',
  rate_limited: 'Saved. Shelly is busy right now — the plug will follow within a minute.',
  device: 'Saved. The plug is not answering — it will follow as soon as it is back online.',
}
const PENDING_FALLBACK = 'Saved. Shelly cloud is not answering — the plug will follow within a minute.'

// The seven fields mig 562's column comment requires of every last_state
// writer. A partial shape is what makes `output` read as "off" when it is
// really "unknown", so a row that is missing any of them is rebuilt rather
// than spread.
const STATE_KEYS = ['online', 'output', 'apower', 'aenergy_wh', 'temperature_c', 'source', 'at']
const hasFullState = (s) =>
  !!s && typeof s === 'object' && !Array.isArray(s) && STATE_KEYS.every((k) => k in s)

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

/**
 * The optimistic last_state after a command we KNOW landed.
 *
 * Only the three fields we have evidence for are asserted — output, source and
 * `at` — plus `online`, which rests on exactly the same evidence as the
 * `last_seen_at` written beside it: Shelly Cloud answers a set/switch for an
 * unreachable device with a body-level error, which client.js tags
 * `kind:'device'`, so an ok result means the plug spoke. If that ever proves
 * wrong, this line and the last_seen_at stamp must change together.
 *
 * Everything else (watts, energy, temperature) is carried over untouched: we
 * did not measure it, and inventing a 0 W reading is a claim about the world
 * (status.js rule 1). The next cron read replaces the lot within a minute.
 */
function optimisticState(prev, channel, on, nowIso) {
  const base = hasFullState(prev)
    ? { ...prev }
    : stateFromReading(null, { online: true, channels: [] }, channel, nowIso)
  return { ...base, online: true, output: on, source: 'manual', at: nowIso }
}

export const POST = withAuth(
  { permission: 'device_control', schema: ShellyToggleBody },
  async ({ user, db, locationId, input, params }) => {
    const loaded = await loadDevice(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'device read failed', { locationId, error: loaded.error })
      return bad('Could not load this device', 500)
    }
    const device = loaded.device

    const conn = await loadConnectionWithKey(db, locationId)
    if (!conn.ok) {
      if (conn.reason === 'not_connected') {
        return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
      }
      // A read that FAILED is not "not connected": answering that code would
      // send the operator to the Connect form to re-paste a working key.
      logError(MODULE, 'connection read failed', { locationId, reason: conn.reason, error: conn.error })
      return bad('Could not read the Shelly connection', 500)
    }
    // The engine reads the zone off `locations` — graft the session's.
    const engineConn = withLocationTz(conn.connection, user)

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    // ——— back to the schedule ————————————————————————————————————————
    if (input.state === 'auto') {
      const { data: cleared, error: clearError } = await db
        .from('shelly_devices')
        .update({ override: null, updated_at: nowIso })
        .eq('id', device.id)
        .eq('location_id', locationId)
        // The row MUST exist — we just read it — so a zero-row update means it
        // was deleted underneath us, and running the schedule against a device
        // that no longer exists would command a relay nobody owns.
        .select('id')
        .maybeSingle()
      if (clearError) {
        logError(MODULE, 'override clear failed', { locationId, deviceId: device.id, error: clearError.message })
        return bad('Could not clear the override', 500)
      }
      if (!cleared) return notFound()

      // The override is GONE from the row before this runs, so pass the device
      // the same way — planDeviceAction reads `override` off the object it is
      // handed, and the stale one would re-apply the very thing just cleared.
      const result = await runNowForDevice(db, engineConn, { ...device, override: null }, {})
      const cleanDevice = { ...device, override: null }

      if (result.ok) {
        if (result.noop) {
          // Two very different noops, and the operator needs them apart: a
          // device with no schedule has nothing to go back TO, while one whose
          // relay already agrees with its schedule is simply already right.
          return NextResponse.json({
            success: true,
            device: cleanDevice,
            applied: null,
            reason: device.schedule_mode === 'none' ? 'no_schedule' : 'nothing_to_do',
          })
        }
        return NextResponse.json({
          success: true, device: cleanDevice, applied: result.action, reason: result.reason,
        })
      }

      // EVERY failure below is reported against a row whose override is
      // already cleared — the operator's actual request landed. So the copy
      // says what did happen, and the cron picks the schedule up at the next
      // boundary either way.
      const resumes = 'Back on its schedule — but we could not apply it right now. The next tick will.'
      if (result.kind === 'auth') {
        // Same treatment as discover/adopt/run-now: only `auth` is evidence
        // about the credential, and it lights the badge that carries the one
        // instruction an operator can act on.
        await markKeyRejected(db, locationId)
        return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, {
          code: 'key_rejected', device: cleanDevice, message: resumes,
        })
      }
      if (result.kind === 'rate_limited') {
        return bad('Shelly is busy — try again in a few seconds', 429, {
          code: 'rate_limited', device: cleanDevice, message: resumes,
        })
      }
      if (result.kind === 'occurrences') {
        // A class-mode device with no readable timetable would be forced OFF
        // on an empty day — the engine refuses rather than invent that, and so
        // does this copy.
        logWarn(MODULE, 'occurrence read failed', { locationId, deviceId: device.id, error: result.error })
        return bad("Could not read today's timetable", 502, {
          code: 'occurrences', device: cleanDevice, message: resumes,
        })
      }
      if (result.kind === 'bad_device') {
        // The row cannot be commanded at all (no device id, or a non-integer
        // channel) — a data fault, not a Shelly one.
        logError(MODULE, 'device row cannot be commanded', { locationId, deviceId: device.id })
        return bad('This device row is incomplete — remove it and adopt it again', 500, {
          code: 'bad_device', device: cleanDevice,
        })
      }
      logWarn(MODULE, 'run-now after clearing the override failed', {
        locationId, deviceId: device.id, kind: result.kind, statusCode: result.statusCode,
      })
      return bad('Shelly cloud did not answer — try again in a minute', 502, {
        code: result.kind, kind: result.kind, device: cleanDevice, message: resumes,
      })
    }

    // ——— force on / off ——————————————————————————————————————————————
    const on = input.state === 'on'
    const tz = requestTz(user)
    const untilMs = input.until ? Date.parse(input.until) : nextLocalMidnightMs(nowMs, tz)
    if (!Number.isFinite(untilMs)) {
      // Only reachable if nextLocalMidnightMs could not resolve the zone's day
      // boundary. Refuse rather than write an override with an `until` the
      // planner will read as already expired — that would be a switch that
      // reports success and reverts within the minute.
      logError(MODULE, 'could not resolve the override expiry', { locationId, tz })
      return bad('Could not work out when this should end', 500)
    }
    if (untilMs <= nowMs) return bad('That time has already passed', 400)
    if (untilMs > nowMs + MAX_OVERRIDE_HOURS * HOUR_MS) {
      return bad(`An override can last at most ${MAX_OVERRIDE_HOURS} hours`, 400)
    }

    // The schema is the WRITE GUARD, not a formality: `set_at` IS the
    // exactly-once key (overrideKey), and a strict 'on'|'off' is what stops a
    // value the planner cannot read from parking a relay on its schedule
    // instead. safeParse rather than parse so a bad shape is a logged refusal
    // instead of an unhandled throw — either way it is unwritable.
    const built = ShellyOverride.safeParse({
      state: input.state,
      until: new Date(untilMs).toISOString(),
      set_by: user.id,
      set_at: nowIso,
    })
    if (!built.success) {
      logError(MODULE, 'refused to write a malformed override', {
        locationId, deviceId: device.id, issue: built.error.issues[0]?.message,
      })
      return bad('Could not save that override', 500)
    }
    const override = built.data

    // ——— 1. intent, before the command ——————————————————————————————
    const { data: claimed, error: overrideError } = await db
      .from('shelly_devices')
      .update({ override, updated_at: nowIso })
      .eq('id', device.id)
      .eq('location_id', locationId)
      .select('id')
      .maybeSingle()
    if (overrideError) {
      // Fail CLOSED — see (4) in the header. Nothing has been sent.
      logError(MODULE, 'override write failed', { locationId, deviceId: device.id, error: overrideError.message })
      return bad('Could not save that override — nothing was switched', 500)
    }
    if (!claimed) return notFound()

    const withOverride = { ...device, override }

    // ——— 2. the command ——————————————————————————————————————————————
    const res = await createShellyClient(engineConn).setSwitch(device.device_id, device.channel, on)
    if (!res.ok) {
      if (res.kind === 'auth') await markKeyRejected(db, locationId)
      else {
        logWarn(MODULE, 'toggle command did not land', {
          locationId, deviceId: device.id, kind: res.kind, statusCode: res.statusCode,
        })
      }
      const body = {
        success: true,
        device: withOverride,
        applied: false,
        // The cron applies a live override to every adopted device, enabled or
        // not — this is a delay, not a loss.
        pending: true,
        code: PENDING_CODE[res.kind] ?? 'pending',
        kind: res.kind,
        message: PENDING_MESSAGE[res.kind] ?? PENDING_FALLBACK,
      }
      // 429 only for the shared 1 req/sec account budget, so the client backs
      // off instead of re-pressing. Everything else is a 200: the request did
      // what it promised.
      return NextResponse.json(body, { status: res.kind === 'rate_limited' ? 429 : 200 })
    }

    // ——— 3. the stamp (best effort — the relay has already moved) ————
    const { data: stamped, error: stampError } = await db
      .from('shelly_devices')
      .update({
        // The SAME key the planner would have minted, so the next tick reads
        // this override as already applied and does not re-issue it.
        last_applied: { key: overrideKey(override), action: input.state, reason: 'override', at: nowIso },
        last_state: optimisticState(device.last_state, device.channel, on, nowIso),
        last_seen_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', device.id)
      .eq('location_id', locationId)
      .select(DEVICE_COLUMNS)
      .maybeSingle()
    if (stampError || !stamped) {
      logWarn(MODULE, 'toggle stamp write failed — the relay DID move', {
        locationId, deviceId: device.id, error: stampError?.message ?? 'no row',
      })
    }

    return NextResponse.json({
      success: true,
      // The stamped row when we have it; otherwise the row we loaded plus the
      // override we know landed. Never the optimistic last_applied/last_state
      // — those are exactly the fields whose write just failed.
      device: stamped || withOverride,
      applied: true,
    })
  },
)
