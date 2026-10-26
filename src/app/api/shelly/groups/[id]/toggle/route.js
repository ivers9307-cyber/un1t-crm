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
//      group override is already saved, which the copy says.
//   3. ONE set/groups call over the members, switches and lights together.
//      Zero members: no client is even built (Review Focus 1).
//   4. each member that landed is stamped with overrideKey(groupOverride) —
//      the key the planner mints for the effective target — so the next tick
//      reads it as already applied. A lost stamp is logged, never a failure:
//      the relay moved.
//   5. the answer is `applied: 'all' | 'partial' | 'none'` plus
//      `pending_device_ids`: members named in failedCommands, or all of them
//      when the batch failed. They are PENDING, not lost (rule 1).
//      A failedCommands map keyed in a shape we do not recognise stamps
//      nothing and reports everyone pending (reconcile.js's rule: never stamp
//      by absence).
//
// 'auto' clears the group override AND the member overrides, then runs each
// member through runNowForDevice with the (cleared) group, SEQUENTIALLY and on
// ONE shared client, because they share the account's 1 req/sec budget and the
// client's pacing only spaces calls made through the same instance. A
// rejected key or a bad host stops the run (nothing after it can land); the
// rest are reported per member.
//
// TWO REGIMES, as for a device: on an UNMANAGED group (disabled or mode 'none')
// planner rule 2 never closes an expired override, so `until` bounds the
// banner, not the relays — `holds_until_changed: true` and the notice.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { createShellyClient } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { DEVICE_COLUMNS, requestTz, withLocationTz } from '@/lib/shelly/device-load'
import { loadGroup, publicGroup } from '@/lib/shelly/group-load'
import { optimisticState } from '@/lib/shelly/optimistic-state'
import { overrideKey } from '@/lib/shelly/plan'
import { runNowForDevice, deviceKind } from '@/lib/shelly/reconcile'
import { ShellyGroupToggle, ShellyOverride, MAX_OVERRIDE_HOURS, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'
import { groupId } from '@/lib/shelly/status'
import { nextLocalMidnightMs } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
const partialMessage = (n, total) =>
  `Saved. ${n} of ${total} did not answer — ${n === 1 ? 'it' : 'they'} will follow as soon as ${n === 1 ? 'it is' : 'they are'} back online.`

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
    const members = (memberRows || []).slice(0, MAX_DEVICES_PER_LOCATION)

    const conn = await loadConnectionWithKey(db, locationId)
    if (!conn.ok) {
      if (conn.reason === 'not_connected') {
        return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
      }
      logError(MODULE, 'connection read failed', { locationId, reason: conn.reason, error: conn.error })
      return bad('Could not read the Shelly connection', 500)
    }
    const engineConn = withLocationTz(conn.connection, user)

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
        return bad(
          override
            ? 'Saved for the group, but its devices keep their own switch settings — nothing was sent. Try again.'
            : 'The group is back on its schedule, but its devices keep their own switch settings — try again.',
          500,
          { code: 'member_overrides_not_cleared', group: publicGroup(savedGroup) },
        )
      }
    }
    const cleared = members.map((m) => ({ ...m, override: null }))

    if (input.state === 'auto') return backToSchedule({ db, engineConn, locationId, group: savedGroup, members: cleared, unmanaged })

    // ——— 3. one command over the members ————————————————————————————
    const on = override.state === 'on'
    const holds = { holds_until_changed: unmanaged, ...(unmanaged ? { notice: GROUP_HOLDS_NOTICE } : {}) }
    if (!members.length) {
      return NextResponse.json({ success: true, applied: 'all', pending_device_ids: [], group: publicGroup(savedGroup), ...holds })
    }

    const batch = []
    const pending = new Set()
    for (const m of cleared) {
      try {
        batch.push({ device: m, gid: groupId(m) })
      } catch {
        // A row with no device id or a non-integer channel cannot be named in a
        // command. Pending (it cannot land), loud, and not fatal to the rest.
        logWarn(MODULE, 'unusable member row — no group id', { locationId, groupId: group.id, deviceId: m.id })
        pending.add(m.id)
      }
    }

    let res = { ok: true, failed: {} }
    if (batch.length) {
      const shelly = createShellyClient(engineConn)
      res = await shelly.setGroups({
        switch: batch.filter((x) => deviceKind(x.device) === 'switch').map((x) => x.gid),
        light: batch.filter((x) => deviceKind(x.device) === 'light').map((x) => x.gid),
      }, on)
    }

    if (!res.ok) {
      if (res.kind === 'auth') await markKeyRejected(db, locationId)
      else {
        logWarn(MODULE, 'group command did not land', {
          locationId, groupId: group.id, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode ?? null, count: batch.length,
        })
      }
      return NextResponse.json({
        success: true,
        applied: 'none',
        pending: true,
        pending_device_ids: members.map((m) => m.id),
        code: PENDING_CODE[res.kind] ?? 'pending',
        kind: res.kind,
        message: PENDING_MESSAGE[res.kind] ?? PENDING_FALLBACK,
        group: publicGroup(savedGroup),
        ...holds,
      }, { status: res.kind === 'rate_limited' ? 429 : 200 })
    }

    // Never stamp by absence: one key we do not recognise and the whole map
    // is distrusted (reconcile.js's rule, same reason).
    const gids = new Set(batch.map((x) => x.gid))
    const stray = Object.keys(res.failed || {}).find((k) => !gids.has(k))
    if (stray !== undefined) {
      logWarn(MODULE, 'failedCommands keyed in an unrecognised shape — nothing stamped', {
        locationId, groupId: group.id, sample: String(stray).slice(0, 64),
      })
      for (const x of batch) pending.add(x.device.id)
    } else {
      // ——— 4. stamp what landed ————————————————————————————————————
      const key = overrideKey(override)
      for (const x of batch) {
        const code = res.failed?.[x.gid]
        if (code !== undefined) {
          logWarn(MODULE, 'member command failed', { locationId, deviceId: x.device.id, code: String(code).slice(0, 64) })
          pending.add(x.device.id)
          continue
        }
        const { error: stampError } = await db
          .from('shelly_devices')
          .update({
            last_applied: { key, action: override.state, reason: 'override', at: nowIso },
            last_state: optimisticState(x.device.last_state, x.device.channel, on, nowIso, deviceKind(x.device)),
            last_seen_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', x.device.id)
          .eq('location_id', locationId)
        // The relay moved; a lost stamp is bookkeeping (the next tick re-sends
        // the same idempotent command under the same key).
        if (stampError) logWarn(MODULE, 'member stamp write failed — the relay DID move', { locationId, deviceId: x.device.id, error: stampError.message })
      }
    }

    // ——— 5. the answer ————————————————————————————————————————————
    const pendingIds = members.map((m) => m.id).filter((id) => pending.has(id))
    const applied = appliedOf(pendingIds.length, members.length)
    return NextResponse.json({
      success: true,
      applied,
      pending_device_ids: pendingIds,
      ...(applied === 'all' ? {} : {
        pending: true,
        code: 'pending',
        message: applied === 'none' ? PENDING_FALLBACK : partialMessage(pendingIds.length, members.length),
      }),
      group: publicGroup(savedGroup),
      ...holds,
    })
  },
)

/**
 * 'auto', after both overrides are cleared: run each member through the
 * group's schedule now. Sequential, one shared client (see the header).
 */
async function backToSchedule({ db, engineConn, locationId, group, members, unmanaged }) {
  if (!members.length) {
    return NextResponse.json({ success: true, applied: 'all', pending_device_ids: [], results: [], group: publicGroup(group) })
  }
  // An unmanaged group has nothing to go back to: the forced planner's only
  // null path (rule 2) would answer a no-op for every member. Said once, here,
  // instead of N identical no-ops — and no cloud call is spent on it.
  if (unmanaged) {
    return NextResponse.json({
      success: true,
      applied: null,
      reason: group.enabled ? 'no_schedule' : 'disabled',
      pending_device_ids: [],
      results: [],
      group: publicGroup(group),
    })
  }

  const shared = createShellyClient(engineConn)
  const makeClient = () => shared
  const results = []
  let stopped = null
  for (const m of members) {
    if (stopped) {
      results.push({ device_id: m.id, applied: null, code: stopped })
      continue
    }
    const r = await runNowForDevice(db, engineConn, m, { group, makeClient })
    if (r.ok && !r.noop) {
      results.push({ device_id: m.id, applied: r.action, reason: r.reason })
      continue
    }
    if (r.ok && r.noop) {
      // Unreachable for a managed group under force (see the device toggle's
      // header); kept loud rather than reported as "already correct".
      logError(MODULE, 'run-now answered an unexpected no-op for a managed group member', { locationId, groupId: group.id, deviceId: m.id })
      results.push({ device_id: m.id, applied: null, code: 'unexpected_noop' })
      continue
    }
    results.push({ device_id: m.id, applied: null, code: r.kind, ...(r.code ? { shelly_code: r.code } : {}) })
    // A rejected key, a bad host or an unreadable timetable fails every member
    // the same way: stop spending the budget on them.
    if (r.kind === 'auth' || r.kind === 'config' || r.kind === 'occurrences') {
      if (r.kind === 'auth') await markKeyRejected(db, locationId)
      else logWarn(MODULE, 'back-to-schedule stopped', { locationId, groupId: group.id, kind: r.kind })
      stopped = r.kind
    }
  }

  const pendingIds = results.filter((r) => r.applied == null).map((r) => r.device_id)
  return NextResponse.json({
    success: true,
    applied: appliedOf(pendingIds.length, members.length),
    pending_device_ids: pendingIds,
    results,
    group: publicGroup(group),
  })
}
