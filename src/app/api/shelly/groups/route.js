// SHELLYGROUPS.5 — the location's Shelly groups: list them (with members and
// what each is doing now), and create one.
//
// NO location_id IS ACCEPTED. locationId comes from withAuth's ctx and every
// query pins it; the create body is strict, so a stray location_id is a 400.
//
// `now` IS THE ENGINE'S ANSWER. Each group's windows are resolved with
// resolveServeWindows on the group row for the LOCATION's day — the same call
// planDeviceAction makes for a grouped device every tick — so the card and the
// relays cannot disagree about whether a window is open. A timetable that
// cannot be read does not cost the operator the list: class-mode groups are
// marked `windows_unread` instead of being painted idle with an invented time.
//
// NAMES ARE UNIQUE PER STUDIO, CASE-INSENSITIVELY (controller ruling on mig
// 776's case-sensitive UNIQUE): "Fans" and "fans" side by side is a list nobody
// can read. The check is an ilike with the name ESCAPED (a `_` in a name is a
// literal, not a wildcard — CLAUDE.md's ilike rule), and the UNIQUE index's
// raw 23505 maps to the same 409 for the race past the check.
//
// GROUP_COLUMNS is imported (check:select-columns cannot read it); it is
// pinned against mig 776's columns in src/lib/shelly/effective.test.js, and
// publicGroup strips last_applied before anything is returned.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { escapeLikePattern } from '@/lib/like-escape'
import { strictDayStrIn } from '@/lib/location-time'
import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { requestTz } from '@/lib/shelly/device-load'
import { GROUP_COLUMNS } from '@/lib/shelly/effective'
import { publicGroup, NAME_TAKEN } from '@/lib/shelly/group-load'
import { describeGroupNow } from '@/lib/shelly/group-now'
import { isLiveOverride } from '@/lib/shelly/plan'
import { loadTodayOccurrences, MAX_GROUPS } from '@/lib/shelly/reconcile'
import { ShellyGroupCreate, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-groups'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

/**
 * GET — every group at the location, sorted by sort_order then name.
 */
export const GET = withAuth({ permission: 'device_control' }, async ({ user, db, locationId }) => {
  const { data: rows, error } = await db
    .from('shelly_groups')
    .select(GROUP_COLUMNS)
    .eq('location_id', locationId)
    .order('sort_order')
    .order('name')
    // cap + 1: "at the cap" and "the limit dropped the rest" are different
    // facts, and only the sentinel row tells them apart.
    .limit(MAX_GROUPS + 1)
  if (error) {
    logError(MODULE, 'group list failed', { locationId, error: error.message })
    return bad('Could not load your groups', 500)
  }
  let groups = rows || []
  if (groups.length > MAX_GROUPS) {
    logWarn(MODULE, 'group cap exceeded, excess groups hidden', { locationId, cap: MAX_GROUPS })
    groups = groups.slice(0, MAX_GROUPS)
  }

  const membersBy = new Map(groups.map((g) => [g.id, []]))
  if (groups.length) {
    const { data: devs, error: devError } = await db
      .from('shelly_devices')
      .select('id, group_id, last_state')
      .eq('location_id', locationId)
      .in('group_id', groups.map((g) => g.id))
      // A stable order, so the cap below drops the same rows every time.
      .order('created_at')
      .limit(MAX_DEVICES_PER_LOCATION + 1)
    if (devError) {
      logError(MODULE, 'group member read failed', { locationId, error: devError.message })
      return bad('Could not load your groups', 500)
    }
    let memberRows = devs || []
    if (memberRows.length > MAX_DEVICES_PER_LOCATION) {
      // The groups read's rule: cap + 1 tells "at the cap" from "dropped".
      logWarn(MODULE, 'member cap exceeded, excess members hidden', { locationId, cap: MAX_DEVICES_PER_LOCATION })
      memberRows = memberRows.slice(0, MAX_DEVICES_PER_LOCATION)
    }
    for (const d of memberRows) membersBy.get(d.group_id)?.push(d)
  }

  const tz = requestTz(user)
  const nowMs = Date.now()
  const dateStr = strictDayStrIn(nowMs, tz)

  // Only read the timetable when a class group's answer depends on it: a live
  // override decides `now` before any window is looked at.
  const scheduled = (g) => g.enabled && g.schedule_mode !== 'none'
  let occurrences = []
  if (groups.some((g) => scheduled(g) && g.schedule_mode === 'class' && !isLiveOverride(g.override, nowMs))) {
    const res = await loadTodayOccurrences(db, locationId, tz, nowMs)
    if (res.ok) occurrences = res.occurrences
    else {
      occurrences = null
      logWarn(MODULE, 'occurrence read failed — class groups shown as unread', { locationId, error: res.error })
    }
  }

  const out = groups.map((g) => {
    const members = membersBy.get(g.id) || []
    let windows = []
    if (scheduled(g)) {
      windows = g.schedule_mode === 'class' && occurrences === null
        ? null
        : resolveServeWindows(g, dateStr, occurrences || [], tz)
    }
    return {
      ...publicGroup(g),
      device_ids: members.map((m) => m.id),
      now: describeGroupNow(g, members, windows, nowMs),
    }
  })

  return NextResponse.json({ success: true, groups: out })
})

/**
 * POST — create a group. Inert until it gets a schedule or a member: mig 776's
 * defaults are enabled:false, schedule_mode:'none'.
 */
export const POST = withAuth(
  { permission: 'device_control', schema: ShellyGroupCreate },
  async ({ user, db, locationId, input }) => {
    const { count, error: countError } = await db
      .from('shelly_groups')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
    // NEVER `count ?? 0`: an unusable count is not an empty location.
    if (countError || typeof count !== 'number') {
      logError(MODULE, 'group count failed', { locationId, error: countError?.message ?? 'no count' })
      return bad('Could not create the group', 500)
    }
    // The reconcile reads MAX_GROUPS per tick; a group past it would be
    // created, editable and silently never served.
    if (count >= MAX_GROUPS) {
      return bad(`A location can have at most ${MAX_GROUPS} groups`, 409, { code: 'group_limit' })
    }

    const { data: clash, error: clashError } = await db
      .from('shelly_groups')
      .select('id')
      .eq('location_id', locationId)
      .ilike('name', escapeLikePattern(input.name))
      .limit(1)
    if (clashError) {
      logError(MODULE, 'group name check failed', { locationId, error: clashError.message })
      return bad('Could not create the group', 500)
    }
    if (clash?.length) return bad(NAME_TAKEN, 409, { code: 'name_taken' })

    const nowIso = new Date().toISOString()
    const { data: row, error: insertError } = await db
      .from('shelly_groups')
      .insert({
        ...input,
        location_id: locationId,
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select(GROUP_COLUMNS)
      .single()
    if (insertError) {
      if (insertError.code === '23505') return bad(NAME_TAKEN, 409, { code: 'name_taken' })
      if (insertError.code === '23514') {
        logWarn(MODULE, 'group insert failed a CHECK', { locationId, error: insertError.message })
        return bad('That group cannot be saved — check the name and icon', 400)
      }
      logError(MODULE, 'group insert failed', { locationId, code: insertError.code, error: insertError.message })
      return bad('Could not create the group', 500)
    }

    return NextResponse.json({ success: true, group: { ...publicGroup(row), device_ids: [] } }, { status: 201 })
  },
)
