// SHELLYGROUPS.5 — the group switch: force every member of a group on or off
// for a while, or hand the whole group back to its schedule.
//
// GROUP WINS (spec, Richard 2026-10-26). Pressing the group's switch, or its
// "back to schedule", clears every member's own device override first, so
// "1 of 2 on" afterwards only ever means a member that failed, is offline, or
// was switched separately after the press.
//
// THE ORDER IS THE CONTRACT — the device toggle's, widened to a group
// (src/app/api/shelly/devices/[id]/toggle/route.js explains each rule):
//   1. the GROUP override is written first. It is intent: effectiveTarget
//      carries a live group override onto every member, and the cron applies
//      a live override to every adopted device, so a member that does not take
//      the command now follows on a later tick. A failed write here refuses —
//      nothing has been sent.
//   2. every member's device override is cleared (`.eq('group_id', id)` and
//      the location, error checked). If that fails we REFUSE before sending:
//      a member keeping a live device override would be put back by the cron
//      (device beats group), so the press would visibly not hold for it. The
//      group override from step 1 is ROLLED BACK to its previous value first
//      (best-effort, checked, logged on failure), so "nothing was sent" stays
//      true: otherwise the next tick would apply it to every member.
//   3. ONE set/groups call over the members, switches and lights together,
//      on a client with INTERACTIVE_429_RETRIES (SHELLYBUSY.1: a press that
//      lands on the cron's read rides it out instead of answering "busy";
//      'auto' sends through the same call).
//      Zero members: no client is even built (Review Focus 1).
//   4. each member that landed is stamped with overrideKey(groupOverride) —
//      the key the planner mints for the effective target — so the next tick
//      reads it as already applied. A lost stamp is logged, never a failure:
//      the relay moved.
//   5. the answer is `applied: 'all' | 'partial' | 'none'` plus
//      `pending_device_ids`: members named in failedCommands, or all of them
//      when the batch failed. They are PENDING, not lost (rule 1), and
//      `pending_members` says why per member (`code`, Shelly's `shelly_code`,
//      `permanent`). A member Shelly refused with a PERMANENT code
//      (SHELLY_PERMANENT_CODES, client.js) is never promised to follow "once
//      back online" — waiting cannot fix it — so the copy says so.
//      A failedCommands map keyed in a shape we do not recognise stamps
//      nothing and reports everyone pending (reconcile.js's rule: never stamp
//      by absence).
//
// 'auto' clears the group override AND the member overrides (steps 1–2), then
// plans ONCE: with every override gone, each member's effectiveTarget under
// force is the group's schedule, so planDeviceAction gives every member the
// same action and key (a class-mode group's timetable is read once for it, and
// a timetable that cannot be read runs nobody). That plan goes out as ONE
// set/groups batch through the same steps 3–5 as a press, and each member that
// landed is stamped with the PLAN's key/action/reason — exactly what the cron
// would have stamped. One call, not N: N sequential run-nows on a 1 req/sec
// budget made a 20-light group take 20 s and fail half-way on a busy account.
// A member planned differently from the first (a row the group does not
// govern) is skipped and logged by id, never sent the group's action.
//
// TWO REGIMES, as for a device: on an UNMANAGED group (disabled or mode 'none')
// planner rule 2 never closes an expired override, so `until` bounds the
// banner, not the relays — `holds_until_changed: true` and the notice.
//
// THE SAFETY NET (SHELLYTIMERS.3), only while the studio's safety-timer
// switch is on (SHELLYTIMERS.5, off by default), the device toggle's rule
// widened: a press
// ON for a MANAGED group sends its one batch with `toggle_after` up to
// `until` + SAFETY_MARGIN_MS, and every member that landed is stamped with
// `cap_at`. An unmanaged group, and every OFF press, gets no timer (the
// "stays until changed" promise; a timer on an off would flip the room back
// on). 'auto' arms by the planner's window rule: the plan carries the cap.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { createShellyClient, INTERACTIVE_429_RETRIES, SHELLY_PERMANENT_CODES } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { loadSafetyTimers } from '@/lib/shelly/safety-timers'
import { DEVICE_COLUMNS, requestTz, withLocationTz } from '@/lib/shelly/device-load'
import { loadGroup, publicGroup } from '@/lib/shelly/group-load'
import { effectiveTarget } from '@/lib/shelly/effective'
import { optimisticState } from '@/lib/shelly/optimistic-state'
import { overrideKey, planDeviceAction, safetyCap, SAFETY_MARGIN_MS } from '@/lib/shelly/plan'
import { deviceKind, loadTodayOccurrences, appliedStamp } from '@/lib/shelly/reconcile'
import { ShellyGroupToggle, ShellyOverride, MAX_OVERRIDE_HOURS, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'
import { groupId } from '@/lib/shelly/status'
import { nextLocalMidnightMs, strictDayStrIn } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Kept above the platform default: both branches send ONE batch now, but that
// call may ride out INTERACTIVE_429_RETRIES on a busy account, and up to
// MAX_DEVICES_PER_LOCATION member stamps follow it one write at a time.
export const maxDuration = 120

const MODULE = 'shelly-group-toggle'
const HOUR_MS = 60 * 60 * 1000

export const GROUP_HOLDS_NOTICE = 'No schedule is running this group, so its lights stay as you set them until you change them'

// Our `code` vocabulary for a batch that did not land, keyed by the client's
// failure tag — the device toggle's, so the page branches the same way.
const PENDING_CODE = { auth: 'key_rejected', rate_limited: 'rate_limited', config: 'bad_host' }
const PENDING_MESSAGE = {
  auth: 'Saved. Shelly rejected the stored key — re-paste it from the Shelly app and the group will follow.',
  rate_limited: 'Saved. Shelly is busy right now — the group will follow within a minute.',
  config: 'Saved. The Shelly server on file is invalid; fix it in the connection settings and the group will follow.',
}
const PENDING_FALLBACK = 'Saved. Shelly cloud is not answering — the group will follow within a minute.'
// SHELLYERR.1 — a whole batch Shelly refused with a code waiting cannot fix.
const refusedBatchMessage = (code) =>
  `Saved, but Shelly refused the command (${code}). Check these devices in the Shelly app — they will not follow until that is fixed.`

// The copy for some or all members pending, split by whether waiting can fix
// it: a member refused with a permanent code is told to be checked, never
// promised to follow "once back online".
export function pendingMessage(pendingMembers, total) {
  const refused = pendingMembers.filter((p) => p.permanent).length
  const waiting = pendingMembers.length - refused
  const parts = []
  if (waiting) {
    parts.push(`${waiting} of ${total} did not answer — ${waiting === 1 ? 'it' : 'they'} will follow as soon as ${waiting === 1 ? 'it is' : 'they are'} back online.`)
  }
  if (refused) {
    parts.push(`Shelly refused the command for ${refused} of ${total} — check ${refused === 1 ? 'it' : 'them'} in the Shelly app; ${refused === 1 ? 'it' : 'they'} will not follow until that is fixed.`)
  }
  return `Saved. ${parts.join(' ')}`
}

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

const appliedOf = (pending, total) => (pending === 0 ? 'all' : pending === total ? 'none' : 'partial')

export const POST = withAuth(
  { permission: 'device_control', schema: ShellyGroupToggle },
  async ({ user, db, locationId, input, params }) => {
    const loaded = await loadGroup(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'group read failed', { locationId, error: loaded.error })
      return bad('Could not load this group', 500)
    }
    const group = loaded.group

    const { data: memberRows, error: memberError } = await db
      .from('shelly_devices')
      .select(DEVICE_COLUMNS)
      .eq('location_id', locationId)
      .eq('group_id', group.id)
      .order('created_at')
      .limit(MAX_DEVICES_PER_LOCATION + 1)
    if (memberError) {
      logError(MODULE, 'member read failed', { locationId, groupId: group.id, error: memberError.message })
      return bad("Could not load this group's devices", 500)
    }
    const rawMembers = memberRows || []
    if (rawMembers.length > MAX_DEVICES_PER_LOCATION) {
      // cap + 1 asked for, so this is "the limit dropped the rest", not "at
      // the cap" — the groups read's rule. Ids and counts only.
      logWarn(MODULE, 'member cap exceeded, excess members not switched', { locationId, groupId: group.id, cap: MAX_DEVICES_PER_LOCATION })
    }
    const members = rawMembers.slice(0, MAX_DEVICES_PER_LOCATION)

    const conn = await loadConnectionWithKey(db, locationId)
    if (!conn.ok) {
      if (conn.reason === 'not_connected') {
        return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
      }
      logError(MODULE, 'connection read failed', { locationId, reason: conn.reason, error: conn.error })
      return bad('Could not read the Shelly connection', 500)
    }
    // The studio's safety-timer switch rides beside the zone (SHELLYTIMERS.5).
    const safetyTimers = await loadSafetyTimers(db, locationId)
    const engineConn = withLocationTz(conn.connection, user, { safetyTimers })

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const unmanaged = !group.enabled || group.schedule_mode === 'none'

    // ——— the override to write (null for 'auto') ————————————————————
    let override = null
    if (input.state !== 'auto') {
      const tz = requestTz(user)
      const untilMs = input.until ? Date.parse(input.until) : nextLocalMidnightMs(nowMs, tz)
      if (!Number.isFinite(untilMs)) {
        logError(MODULE, 'could not resolve the override expiry', { locationId, tz })
        return bad('Could not work out when this should end', 500)
      }
      if (untilMs <= nowMs) return bad('That time has already passed', 400)
      if (untilMs > nowMs + MAX_OVERRIDE_HOURS * HOUR_MS) {
        return bad(`An override can last at most ${MAX_OVERRIDE_HOURS} hours`, 400)
      }
      // The write guard (set_at IS the exactly-once key; see ShellyOverride).
      const built = ShellyOverride.safeParse({
        state: input.state, until: new Date(untilMs).toISOString(), set_by: user.id, set_at: nowIso,
      })
      if (!built.success) {
        logError(MODULE, 'refused to write a malformed override', { locationId, groupId: group.id, issue: built.error.issues[0]?.message })
        return bad('Could not save that override', 500)
      }
      override = built.data
    }

    // ——— 1. the group's intent ——————————————————————————————————————
    const { data: claimed, error: overrideError } = await db
      .from('shelly_groups')
      .update({ override, updated_at: nowIso })
      .eq('id', group.id)
      .eq('location_id', locationId)
      .select('id')
      .maybeSingle()
    if (overrideError) {
      logError(MODULE, 'group override write failed', { locationId, groupId: group.id, error: overrideError.message })
      return bad(override ? 'Could not save that — nothing was switched' : 'Could not hand the group back to its schedule', 500)
    }
    if (!claimed) return notFound()
    const savedGroup = { ...group, override }

    // ——— 2. group wins: clear every member's own override ————————————
    if (members.length) {
      const { error: clearError } = await db
        .from('shelly_devices')
        .update({ override: null, updated_at: nowIso })
        .eq('group_id', group.id)
        .eq('location_id', locationId)
      if (clearError) {
        logError(MODULE, 'member override clear failed', { locationId, groupId: group.id, error: clearError.message })
        // Roll step 1 back so "nothing was sent" stays true: a live group
        // override left on the row would be applied by the next tick to every
        // member without a device override of its own. Best-effort, checked.
        const { error: rollbackError } = await db
          .from('shelly_groups')
          .update({ override: group.override ?? null, updated_at: nowIso })
          .eq('id', group.id)
          .eq('location_id', locationId)
        if (rollbackError) {
          logWarn(MODULE, 'group override rollback failed — the saved override stands', {
            locationId, groupId: group.id, error: rollbackError.message,
          })
        }
        return bad(
          override
            ? "Could not take over this group's devices — nothing was sent. Try again."
            : 'Could not hand the group back to its schedule — nothing was changed. Try again.',
          500,
          { code: 'member_overrides_not_cleared', group: publicGroup(rollbackError ? savedGroup : group) },
        )
      }
    }
    const cleared = members.map((m) => ({ ...m, override: null }))

    if (input.state === 'auto') {
      return backToSchedule({ db, engineConn, locationId, group: savedGroup, members: cleared, tz: requestTz(user), nowMs, nowIso, safetyTimers })
    }

    // ——— 3–4. one command over the members, stamp what landed ——————————
    const on = override.state === 'on'
    const holds = { holds_until_changed: unmanaged, ...(unmanaged ? { notice: GROUP_HOLDS_NOTICE } : {}) }
    if (!members.length) {
      return NextResponse.json({ success: true, applied: 'all', pending_device_ids: [], group: publicGroup(savedGroup), ...holds })
    }

    const cap = on && !unmanaged && safetyTimers ? safetyCap(Date.parse(override.until) + SAFETY_MARGIN_MS, nowMs) : null
    const sent = await sendAndStamp({
      db, engineConn, locationId, groupId: group.id, members: cleared, on, nowIso,
      toggleAfterSec: cap?.toggleAfterSec ?? null,
      lastApplied: appliedStamp({ key: overrideKey(override), action: override.state, reason: 'override', capAt: cap?.capAt }, nowIso),
    })

    if (sent.batchFailure) {
      const res = sent.batchFailure
      // SHELLYERR.1, the device toggle's rule: a code that waiting cannot fix
      // is never answered with "the group will follow".
      const refused = res.kind === 'device' && res.permanent === true
      return NextResponse.json({
        success: true,
        applied: 'none',
        pending: true,
        pending_device_ids: members.map((m) => m.id),
        pending_members: members.map((m) => sent.pending.get(m.id)),
        code: refused ? 'device_refused' : (PENDING_CODE[res.kind] ?? 'pending'),
        kind: res.kind,
        message: refused ? refusedBatchMessage(res.code) : (PENDING_MESSAGE[res.kind] ?? PENDING_FALLBACK),
        ...(refused ? { shelly_code: res.code } : {}),
        group: publicGroup(savedGroup),
        ...holds,
      }, { status: res.kind === 'rate_limited' ? 429 : 200 })
    }

    // ——— 5. the answer ————————————————————————————————————————————
    const pendingMembers = members.map((m) => sent.pending.get(m.id)).filter(Boolean)
    const applied = appliedOf(pendingMembers.length, members.length)
    return NextResponse.json({
      success: true,
      applied,
      pending_device_ids: pendingMembers.map((p) => p.device_id),
      ...(applied === 'all' ? {} : {
        pending: true,
        pending_members: pendingMembers,
        code: 'pending',
        message: pendingMessage(pendingMembers, members.length),
      }),
      group: publicGroup(savedGroup),
      ...holds,
    })
  },
)

/**
 * The one batch both branches send (steps 3 and 4 of the header): ONE
 * set/groups call over every usable member — switches and lights together — on
 * the interactive-retry client, then a stamp for each member that landed.
 *
 * @returns {{ pending: Map<id, {device_id, code, shelly_code?, permanent}>, batchFailure: object|null }}
 *   `pending` names every member that did not land and why; `batchFailure` is
 *   the client's result when the WHOLE call failed (every member is pending).
 */
async function sendAndStamp({ db, engineConn, locationId, groupId: gid0, members, on, nowIso, lastApplied, toggleAfterSec = null }) {
  const pending = new Map()
  const miss = (id, code, shellyCode = null) => {
    const permanent = shellyCode !== null && SHELLY_PERMANENT_CODES.has(shellyCode)
    pending.set(id, { device_id: id, code, ...(shellyCode !== null ? { shelly_code: shellyCode } : {}), permanent })
  }

  const batch = []
  for (const m of members) {
    try {
      batch.push({ device: m, gid: groupId(m) })
    } catch {
      // A row with no device id or a non-integer channel cannot be named in a
      // command. Pending (it cannot land), loud, and not fatal to the rest.
      logWarn(MODULE, 'unusable member row — no group id', { locationId, groupId: gid0, deviceId: m.id })
      miss(m.id, 'bad_device')
    }
  }
  if (!batch.length) return { pending, batchFailure: null }

  const shelly = createShellyClient(engineConn, { max429Retries: INTERACTIVE_429_RETRIES })
  const groups = {
    switch: batch.filter((x) => deviceKind(x.device) === 'switch').map((x) => x.gid),
    light: batch.filter((x) => deviceKind(x.device) === 'light').map((x) => x.gid),
  }
  // The safety-net timer rides only when the caller armed one (header).
  const res = toggleAfterSec == null
    ? await shelly.setGroups(groups, on)
    : await shelly.setGroups(groups, on, { toggleAfterSec })

  if (!res.ok) {
    if (res.kind === 'auth') await markKeyRejected(db, locationId)
    else {
      logWarn(MODULE, 'group command did not land', {
        locationId, groupId: gid0, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode ?? null, count: batch.length,
      })
    }
    const shellyCode = typeof res.code === 'string' ? res.code : null
    for (const m of members) if (!pending.has(m.id)) miss(m.id, res.kind, res.kind === 'device' ? shellyCode : null)
    return { pending, batchFailure: res }
  }

  // Never stamp by absence: one key we do not recognise and the whole map is
  // distrusted (reconcile.js's rule, same reason).
  const gids = new Set(batch.map((x) => x.gid))
  const stray = Object.keys(res.failed || {}).find((k) => !gids.has(k))
  if (stray !== undefined) {
    logWarn(MODULE, 'failedCommands keyed in an unrecognised shape — nothing stamped', {
      locationId, groupId: gid0, sample: String(stray).slice(0, 64),
    })
    for (const x of batch) miss(x.device.id, 'unverified')
    return { pending, batchFailure: null }
  }

  for (const x of batch) {
    const failed = res.failed?.[x.gid]
    if (failed !== undefined) {
      // Truncated: it comes out of a response body, and a body is never
      // logged or returned whole.
      const shellyCode = String(failed).slice(0, 64)
      logWarn(MODULE, 'member command failed', { locationId, deviceId: x.device.id, code: shellyCode })
      miss(x.device.id, 'device', shellyCode)
      continue
    }
    const { error: stampError } = await db
      .from('shelly_devices')
      .update({
        last_applied: lastApplied,
        last_state: optimisticState(x.device.last_state, x.device.channel, on, nowIso, deviceKind(x.device)),
        last_seen_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', x.device.id)
      .eq('location_id', locationId)
    // The relay moved; a lost stamp is bookkeeping (the next tick re-sends the
    // same idempotent command under the same key).
    if (stampError) logWarn(MODULE, 'member stamp write failed — the relay DID move', { locationId, deviceId: x.device.id, error: stampError.message })
  }
  return { pending, batchFailure: null }
}

/**
 * 'auto', after both overrides are cleared: plan the group's schedule ONCE and
 * send it to every member in ONE batch (see the header).
 */
async function backToSchedule({ db, engineConn, locationId, group, members, tz, nowMs, nowIso, safetyTimers = false }) {
  if (!members.length) {
    return NextResponse.json({ success: true, applied: 'all', pending_device_ids: [], results: [], group: publicGroup(group) })
  }
  const noSchedule = () => NextResponse.json({
    success: true,
    applied: null,
    reason: group.enabled ? 'no_schedule' : 'disabled',
    pending_device_ids: [],
    results: [],
    group: publicGroup(group),
  })
  // An unmanaged group has nothing to go back to: the forced planner's only
  // null path (rule 2). Said once, here — no timetable read, no cloud call.
  if (!group.enabled || group.schedule_mode === 'none') return noSchedule()

  // A class-mode group's timetable is read ONCE. A read that fails runs
  // nobody: a forced plan off an empty timetable would be an OFF nobody asked
  // for (runNowForDevice's rule).
  let occurrences = []
  if (group.schedule_mode === 'class') {
    const occ = await loadTodayOccurrences(db, locationId, tz, nowMs)
    if (!occ.ok) {
      logWarn(MODULE, 'back-to-schedule: timetable unreadable — nothing run', { locationId, groupId: group.id, error: occ.error })
      return NextResponse.json({
        success: true,
        applied: 'none',
        pending_device_ids: members.map((m) => m.id),
        results: members.map((m) => ({ device_id: m.id, applied: null, code: 'occurrences' })),
        group: publicGroup(group),
      })
    }
    occurrences = occ.occurrences
  }

  const dateStr = strictDayStrIn(nowMs, tz)
  const planFor = (m) => planDeviceAction(effectiveTarget(m, group, nowMs), nowMs, dateStr, occurrences, tz, { force: true, timers: safetyTimers })

  // Every member's override is cleared, so under force each one's effective
  // target is the group's schedule and its plan is the same: taken from the
  // first member. A member planned differently is a contradiction (a row the
  // group does not govern) — skipped and logged by id, never sent the
  // group's action.
  const plan = planFor(members[0])
  if (!plan) {
    // Unreachable for a managed group under force; kept loud.
    logError(MODULE, 'back-to-schedule: no plan for a managed group', { locationId, groupId: group.id })
    return noSchedule()
  }
  const same = []
  const skipped = new Set()
  for (const m of members) {
    const p = planFor(m)
    if (p && p.action === plan.action && p.key === plan.key) same.push(m)
    else {
      logWarn(MODULE, 'back-to-schedule: member planned differently — skipped', { locationId, groupId: group.id, deviceId: m.id })
      skipped.add(m.id)
    }
  }

  // The plan carries its safety cap when it opens a window (plan.js); the
  // stamp records it exactly as the cron's would.
  const sent = await sendAndStamp({
    db, engineConn, locationId, groupId: group.id, members: same, on: plan.action === 'on', nowIso,
    toggleAfterSec: plan.toggleAfterSec ?? null,
    lastApplied: appliedStamp(plan, nowIso),
  })

  const results = members.map((m) => {
    if (skipped.has(m.id)) return { device_id: m.id, applied: null, code: 'plan_mismatch' }
    const p = sent.pending.get(m.id)
    if (!p) return { device_id: m.id, applied: plan.action, reason: plan.reason }
    return { device_id: m.id, applied: null, code: p.code, ...(p.shelly_code ? { shelly_code: p.shelly_code } : {}), permanent: p.permanent }
  })
  const pendingIds = results.filter((r) => r.applied == null).map((r) => r.device_id)
  return NextResponse.json({
    success: true,
    applied: appliedOf(pendingIds.length, members.length),
    pending_device_ids: pendingIds,
    results,
    group: publicGroup(group),
  })
}
