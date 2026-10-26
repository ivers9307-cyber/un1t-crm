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
//   3. A FAILED *STAMP* IS NOT A FAILED COMMAND. If the command succeeded the
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
// TWO REGIMES, AND `until` DOES NOT MEAN THE SAME THING IN BOTH. This is a
// property of the ENGINE, not of this route, and the route's job is to say so
// rather than to paper over it:
//
//   MANAGED (enabled AND a schedule): the override wins until `until`, and the
//     schedule then resumes IN BOTH DIRECTIONS — plan.js rule 3 re-opens the
//     relay if a window is live, rule 4 closes it with `override_expired` if
//     none is. `until` is a real expiry.
//   UNMANAGED (`enabled:false` OR `schedule_mode:'none'`): plan.js rule 2
//     returns before rule 4 can close anything, so an EXPIRED override is
//     never undone and the relay stays exactly as it was set. That is the
//     approved design ("stays until changed", spec rule 2, pinned by
//     plan.test.js case 15) and it must NOT be changed here — a cron that
//     switched off a plug nobody had asked it to manage is the worse bug.
//     For these devices `until` bounds the BANNER, not the relay, so the
//     response carries `holds_until_changed: true` and the notice below, and
//     Task 6 renders plain On/Off with no expiry time rather than a countdown
//     that would be a lie.
//
// A DEVICE IN A GROUP (SHELLYGROUPS.5). Its device override still wins over the
// group (effective.js), so on/off is unchanged — but "managed" means the
// GROUP's schedule, so `holds_until_changed` is judged on effectiveTarget.
// 'auto' hands the device back to the GROUP's schedule: the group is read
// FIRST and passed to the engine, and a group that cannot be read refuses
// with 409 group_unavailable before the override is touched (running the
// device on its own, cleared schedule would force the relay off).
//
// THE SAFETY NET (SHELLYTIMERS.3). A press ON for a MANAGED device carries a
// device-side timer — `toggle_after` up to `until` + SAFETY_MARGIN_MS, the
// planner's rule for an `on` override, so the cron reads the stamp's cap_at as
// already armed — and the stamp records `cap_at`. The relay then switches
// itself off even if this CRM never gets to close it. Never on:
//   • an UNMANAGED device (and a member whose group could not be read, which
//     we cannot show is managed): the copy promises it "stays as you set it
//     until you change it", and a timer would break that promise (ruling).
//   • an OFF press: a timer flips to the opposite of `on`, so it would switch
//     the room back ON at expiry, fighting the schedule.
// 'auto' goes through runNowForDevice, which arms by the window rule.
//
// TIMEZONE. `until` defaults to the LOCATION's next local midnight, and the
// engine that later expires it resolves the zone from `conn.locations`, which
// loadConnectionWithKey does not select — see withLocationTz in
// src/lib/shelly/device-load.js for why both sides must be given the same
// answer.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { createShellyClient, INTERACTIVE_429_RETRIES } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { loadDevice, DEVICE_COLUMNS, requestTz, withLocationTz } from '@/lib/shelly/device-load'
import { effectiveTarget } from '@/lib/shelly/effective'
import { loadDeviceGroup } from '@/lib/shelly/group-load'
import { overrideKey, safetyCap, isManagedTarget, SAFETY_MARGIN_MS } from '@/lib/shelly/plan'
import { runNowForDevice, deviceKind, appliedStamp } from '@/lib/shelly/reconcile'
import { ShellyToggleBody, ShellyOverride, MAX_OVERRIDE_HOURS } from '@/lib/shelly/schemas'
import { optimisticState } from '@/lib/shelly/optimistic-state'
import { nextLocalMidnightMs } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-toggle'
const HOUR_MS = 60 * 60 * 1000

// The sentence an unmanaged device's toggle has to carry. Exported so Task 6
// renders the same words the API returned rather than re-typing them.
export const HOLDS_NOTICE = 'No schedule is running this plug, so it stays as you set it until you change it'

// OUR vocabulary for a command that has not landed yet, keyed by the client's
// own failure tag. `code` is what the page branches on across the whole Shelly
// surface (`not_connected`, `key_rejected`, `disabled`…), so it stays ours;
// `kind` carries the client's tag verbatim alongside it for the logs.
const PENDING_CODE = { auth: 'key_rejected', rate_limited: 'rate_limited', config: 'bad_host' }

const PENDING_MESSAGE = {
  auth: 'Saved. Shelly rejected the stored key — re-paste it from the Shelly app and the plug will follow.',
  rate_limited: 'Saved. Shelly is busy right now — the plug will follow within a minute.',
  device: 'Saved. The plug is not answering — it will follow as soon as it is back online.',
  // A bad host is not a wait: no request was even made, and no amount of time
  // fixes it. Saying "within a minute" here would be the one pending message
  // that is simply false.
  config: 'Saved. The Shelly server on file is invalid; fix it in the connection settings and the plug will follow.',
}
const PENDING_FALLBACK = 'Saved. Shelly cloud is not answering — the plug will follow within a minute.'

// SHELLYERR.1 — the plug (through Shelly) refused the request itself:
// DEVICE_INVALID_CHANNEL, DEVICE_NOT_FOUND, BAD_REQUEST… Still `pending`, because
// the override IS saved and the cron keeps re-planning it, but no wait fixes
// it, so the one thing this copy must not say is "it will follow".
const refusedMessage = (code) =>
  `Saved, but Shelly refused the command (${code}). Check this plug in the Shelly app — it will not follow until that is fixed.`

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

export const POST = withAuth(
  // WIDGET.1 — the Studio Controls widget's plug button lands here.
  { permission: 'device_control', location: true, schema: ShellyToggleBody, allowWidgetToken: true },
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

    // The member's group, when it has one. Read before anything is written.
    const grouped = await loadDeviceGroup(db, device)
    if (!grouped.ok) {
      logWarn(MODULE, 'group unavailable for a grouped device', {
        locationId, deviceId: device.id, groupId: device.group_id, reason: grouped.reason,
      })
    }
    const group = grouped.ok ? grouped.group : null
    // The schedule the planner judges this device on (the group's, for a member).
    const target = effectiveTarget(device, group, nowMs)

    // ——— back to the schedule ————————————————————————————————————————
    if (input.state === 'auto') {
      // Refused BEFORE the clear: nothing changes when we cannot say what
      // "the schedule" is for this device.
      if (!grouped.ok) {
        return bad("Could not read this device's group — try again", 409, { code: 'group_unavailable' })
      }
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
      const result = await runNowForDevice(db, engineConn, { ...device, override: null }, { group })
      const cleanDevice = { ...device, override: null }

      if (result.ok) {
        if (result.noop) {
          // TWO answers, not three. `runNowForDevice` plans with force:true,
          // and under force the planner has exactly ONE null path: rule 2,
          // the unmanaged device (`!enabled` or `schedule_mode:'none'`). Rule
          // 1 answers for any live override, rule 3 for an active window, and
          // rule 4's `if (force) return {action:'off'}` catches everything
          // else — so "the relay already agrees with its schedule" NEVER
          // reaches here under force, and the `nothing_to_do` arm this used to
          // carry was dead code that could only ever have lied. SHELLY-UI.9b
          // removed it: telling an operator "already on schedule" about a
          // device we in fact declined to touch is the false-reassurance shape
          // this file exists to avoid.
          if (!target.enabled) {
            return NextResponse.json({ success: true, device: cleanDevice, applied: null, reason: 'disabled' })
          }
          if (target.schedule_mode === 'none') {
            return NextResponse.json({ success: true, device: cleanDevice, applied: null, reason: 'no_schedule' })
          }
          // Unreachable by the argument above, and therefore the one case
          // that must NOT be dressed as a success: a managed device answering
          // a bare noop under force means the planner and this route disagree
          // about what force means, and inventing "already correct" would hide
          // that behind a green tick forever. The override IS cleared either
          // way (that write already landed), so the copy says so.
          logError(MODULE, 'run-now answered an unexpected no-op for a managed device', {
            locationId, deviceId: device.id, enabled: target.enabled, scheduleMode: target.schedule_mode,
          })
          return bad(
            'The override was cleared, but the schedule could not be applied — try Run now',
            500,
            { code: 'unexpected_noop', device: cleanDevice },
          )
        }
        return NextResponse.json({
          success: true, device: cleanDevice, applied: result.action, reason: result.reason,
        })
      }

      // EVERY failure below is reported against a row whose override is
      // already cleared — the operator's actual request landed. So the copy
      // says what did happen, and the cron picks the schedule up at the next
      // boundary either way.
      // THE REASSURANCE MUST BE IN `error`. The client's default renderer is
      // `issues?.[0]?.message || message || error`, and on a failure body the
      // operator sees the error string — a sentence parked in a `message` field
      // beside it is one nobody reads. (`message` still rides on the SUCCESS
      // pending bodies further down, where the card branches on `pending`
      // before it renders anything.)
      const resumes = ' The device is back on its schedule and will resume at the next boundary.'
      if (result.kind === 'auth') {
        // Same treatment as discover/adopt/run-now: only `auth` is evidence
        // about the credential, and it lights the badge that carries the one
        // instruction an operator can act on.
        await markKeyRejected(db, locationId)
        return bad('Shelly rejected the stored key — re-paste it from the Shelly app.' + resumes, 409, {
          code: 'key_rejected', device: cleanDevice,
        })
      }
      if (result.kind === 'rate_limited') {
        return bad('Shelly is busy — try again in a few seconds.' + resumes, 429, {
          code: 'rate_limited', device: cleanDevice,
        })
      }
      if (result.kind === 'occurrences') {
        // A class-mode device with no readable timetable would be forced OFF
        // on an empty day — the engine refuses rather than invent that, and so
        // does this copy.
        logWarn(MODULE, 'occurrence read failed', { locationId, deviceId: device.id, error: result.error })
        return bad("Could not read today's timetable." + resumes, 502, {
          code: 'occurrences', device: cleanDevice,
        })
      }
      if (result.kind === 'bad_device') {
        // The row cannot be commanded at all (no device id, or a non-integer
        // channel) — a data fault, not a Shelly one, and the ONE case that gets
        // no reassurance: the next tick cannot apply this row either, so
        // promising it would resume is the false comfort the rest of this
        // block exists to avoid.
        logError(MODULE, 'device row cannot be commanded', { locationId, deviceId: device.id })
        return bad('This device row is incomplete — remove it and adopt it again', 500, {
          code: 'bad_device', device: cleanDevice,
        })
      }
      logWarn(MODULE, 'run-now after clearing the override failed', {
        locationId, deviceId: device.id, kind: result.kind, statusCode: result.statusCode,
      })
      return bad('Shelly cloud did not answer — try again in a minute.' + resumes, 502, {
        code: result.kind, kind: result.kind, device: cleanDevice,
      })
    }

    // ——— force on / off ——————————————————————————————————————————————
    const on = input.state === 'on'
    // See "TWO REGIMES" in the header: on an unmanaged device the engine never
    // closes an expired override (plan.js rule 2 returns before rule 4), so the
    // relay holds until a human changes it and `until` bounds only the banner.
    // Judged on the effective schedule (the group's, for a member). If the
    // member's group could not be read we do not know whether a schedule will
    // close this override, so we claim nothing: holds_until_changed false and
    // no notice (controller ruling). The device's own fields would say
    // "unmanaged" — joining cleared them — which is evidence we do not have.
    // A manual switch is not worth refusing over a banner flag.
    const unmanaged = grouped.ok && (!target.enabled || target.schedule_mode === 'none')
    // The other side of that judgement, for the timer: only a target we KNOW
    // is managed is armed (see THE SAFETY NET in the header).
    const managed = grouped.ok && isManagedTarget(target)
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
    // A light is a `light:N` component, addressed through set/light; set/switch
    // would name a component the device does not have (SHELLYLIGHT.3).
    // Three 429 retries (1.1 s, 2.2 s, 3.3 s): a press that lands on the
    // cron's read rides it out instead of answering "busy". SHELLYBUSY.1.
    const cap = on && managed ? safetyCap(untilMs + SAFETY_MARGIN_MS, nowMs) : null
    const timer = cap ? [{ toggleAfterSec: cap.toggleAfterSec }] : []
    const shelly = createShellyClient(engineConn, { max429Retries: INTERACTIVE_429_RETRIES })
    const res = deviceKind(device) === 'light'
      ? await shelly.setLight(device.device_id, device.channel, on, ...timer)
      : await shelly.setSwitch(device.device_id, device.channel, on, ...timer)
    if (!res.ok) {
      if (res.kind === 'auth') await markKeyRejected(db, locationId)
      else {
        logWarn(MODULE, 'toggle command did not land', {
          locationId, deviceId: device.id, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode,
        })
      }
      const refused = res.kind === 'device' && res.permanent === true
      const body = {
        success: true,
        device: withOverride,
        applied: false,
        // The cron applies a live override to every adopted device, enabled or
        // not — this is a delay, not a loss.
        pending: true,
        code: refused ? 'device_refused' : (PENDING_CODE[res.kind] ?? 'pending'),
        kind: res.kind,
        message: refused ? refusedMessage(res.code) : (PENDING_MESSAGE[res.kind] ?? PENDING_FALLBACK),
        ...(refused ? { shelly_code: res.code } : {}),
        // Carried on the pending body too: what the cron eventually applies is
        // the same override, so the same "it will hold" is true of it.
        holds_until_changed: unmanaged,
        ...(unmanaged ? { notice: HOLDS_NOTICE } : {}),
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
        // cap_at only when the command carried a timer (appliedStamp).
        last_applied: appliedStamp({ key: overrideKey(override), action: input.state, reason: 'override', capAt: cap?.capAt }, nowIso),
        last_state: optimisticState(device.last_state, device.channel, on, nowIso, deviceKind(device)),
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
      // TRUE means `until` is a banner, not an expiry — nothing will put this
      // relay back. Always present (never conditionally omitted) so the client
      // reads a boolean rather than inferring one from an absent key.
      holds_until_changed: unmanaged,
      ...(unmanaged ? { notice: HOLDS_NOTICE } : {}),
    })
  },
)
