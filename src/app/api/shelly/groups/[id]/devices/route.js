// SHELLYGROUPS.5 — set a group's membership.
//
// PUT { device_ids } REPLACES the membership. The rules, each load-bearing:
//
//  1. EVERY id must be a device at the caller's location, or the whole request
//     is a 404 and nothing is written. One read of the location's devices
//     (capped like everything else) decides it before any write, so a guessed
//     id from another studio can neither join nor reveal itself (the 404 is the
//     same as for an id that does not exist).
//  2. JOINING clears the device's own schedule (schedule_mode 'none', no
//     windows, an empty class rule; `enabled` is kept). Spec: leaving a group
//     must never revive a stale, invisible schedule — which is also why the
//     device PATCH refuses a schedule edit on a grouped device (409
//     `grouped`): a schedule written while grouped would be exactly that.
//     A joiner's own live device OVERRIDE is cleared too (group wins, Richard
//     2026-10-26): a device override beats the group's in effectiveTarget, so
//     a joiner keeping one would not follow the group it was just put in until
//     the override ran out. A device already in the group is not re-joining
//     and keeps whatever it has. A device moving from
//     another group at the studio simply joins this one — a device is in at
//     most one group.
//  3. LEAVING writes group_id null and nothing else. No relay is commanded,
//     here or anywhere in this file: membership is configuration. A leaver
//     falls back to its own schedule, which joining cleared, so it stays as
//     it is until someone switches it.
//
// Every write pins location_id and checks its error (a supabase write
// resolves with { error } rather than throwing).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { loadGroup, publicGroup } from '@/lib/shelly/group-load'
import { ShellyGroupMembers, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-group-devices'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

export const PUT = withAuth(
  { permission: 'device_control', schema: ShellyGroupMembers },
  async ({ db, locationId, input, params }) => {
    const loaded = await loadGroup(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'group read failed', { locationId, error: loaded.error })
      return bad('Could not load this group', 500)
    }
    const group = loaded.group

    const { data: rows, error: readError } = await db
      .from('shelly_devices')
      .select('id, group_id')
      .eq('location_id', locationId)
      .limit(MAX_DEVICES_PER_LOCATION + 1)
    if (readError) {
      logError(MODULE, 'device read failed', { locationId, groupId: group.id, error: readError.message })
      return bad('Could not load your devices', 500)
    }
    const devices = rows || []
    if (devices.length > MAX_DEVICES_PER_LOCATION) {
      logWarn(MODULE, 'device cap exceeded, membership judged on the first rows', { locationId, cap: MAX_DEVICES_PER_LOCATION })
    }
    const byId = new Map(devices.slice(0, MAX_DEVICES_PER_LOCATION).map((d) => [d.id, d]))

    // uuidLike accepts any case; the table stores lower case.
    const wanted = input.device_ids.map((id) => String(id).toLowerCase())
    if (wanted.some((id) => !byId.has(id))) return notFound()

    const wantedSet = new Set(wanted)
    const joining = wanted.filter((id) => byId.get(id).group_id !== group.id)
    const leaving = [...byId.values()].filter((d) => d.group_id === group.id && !wantedSet.has(d.id)).map((d) => d.id)
    const nowIso = new Date().toISOString()

    if (joining.length) {
      const { error } = await db
        .from('shelly_devices')
        .update({ group_id: group.id, schedule_mode: 'none', fixed_windows: [], class_rule: {}, override: null, updated_at: nowIso })
        .in('id', joining)
        .eq('location_id', locationId)
      if (error) {
        logError(MODULE, 'join write failed', { locationId, groupId: group.id, count: joining.length, error: error.message })
        return bad('Could not save the group’s devices — nothing was changed', 500)
      }
    }

    if (leaving.length) {
      const { error } = await db
        .from('shelly_devices')
        .update({ group_id: null, updated_at: nowIso })
        .in('id', leaving)
        .eq('location_id', locationId)
        // Only release rows that are still ours: a concurrent move to another
        // group must not be undone by this request.
        .eq('group_id', group.id)
      if (error) {
        // The joins above DID land; say so rather than "nothing changed".
        logError(MODULE, 'leave write failed', { locationId, groupId: group.id, count: leaving.length, error: error.message })
        return bad('Added the new devices, but could not remove the others — reload and try again', 500, { code: 'partial' })
      }
    }

    return NextResponse.json({
      success: true,
      group: publicGroup(group),
      device_ids: wanted,
      joined: joining,
      left: leaving,
    })
  },
)
