// SHELLYGROUPS.5 — edit one group, or remove it.
//
// NEITHER HANDLER TOUCHES A RELAY — the device PATCH/DELETE rule, for the same
// reasons (src/app/api/shelly/devices/[id]/route.js):
//   * switching a group's schedule off, or setting it to 'none', leaves every
//     member exactly as it is (planner rule 2: "not mine to touch", not
//     "switch it off"), so the response carries GROUP_DISABLE_NOTICE;
//   * deleting a group releases its members through the FK (ON DELETE SET
//     NULL, mig 776). They fall back to their OWN schedule, which joining the
//     group cleared and the device PATCH refuses to write back while they are
//     grouped (409 `grouped`), so they are unmanaged and stay as they are.
//     Nothing is sent.
//
// A `class_rule` in the patch is PARTIAL: it is merged onto the stored rule
// and the merged rule is validated with ShellyClassRule (which fills the
// engine's defaults for anything neither side has, and drops keys the engine
// does not read), so `{ lead_min: 20 }` changes the lead and nothing else.
//
// Every write pins `location_id` in the WHERE clause; a foreign id and a
// malformed one answer the same 404 (group-load.js).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { escapeLikePattern } from '@/lib/like-escape'
import { GROUP_COLUMNS } from '@/lib/shelly/effective'
import { loadGroup, publicGroup, NAME_TAKEN } from '@/lib/shelly/group-load'
import { ShellyGroupPatch, ShellyClassRule } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-group'

export const GROUP_DISABLE_NOTICE = 'Schedule switched off — the lights in this group stay as they are until you switch them'
export const GROUP_DELETED_MESSAGE = 'Group removed. Its devices stay as they are until you switch them.'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

const notFound = () => bad('Not found', 404)

const managed = (g) => !!g?.enabled && g.schedule_mode !== 'none'

export const PATCH = withAuth(
  { permission: 'device_control', schema: ShellyGroupPatch },
  async ({ db, locationId, input, params }) => {
    const loaded = await loadGroup(db, locationId, params?.id)
    if (!loaded.ok) {
      if (loaded.status === 404) return notFound()
      logError(MODULE, 'group read failed', { locationId, error: loaded.error })
      return bad('Could not load this group', 500)
    }
    const group = loaded.group

    const patch = { ...input }
    if (input.class_rule !== undefined) {
      const stored = group.class_rule && typeof group.class_rule === 'object' && !Array.isArray(group.class_rule)
        ? group.class_rule
        : {}
      const merged = ShellyClassRule.safeParse({ ...stored, ...input.class_rule })
      if (!merged.success) {
        // A stored value the schema no longer accepts (written before a bound
        // tightened) — say which field, never echo the value.
        const issue = merged.error.issues[0]
        return bad(`That class rule cannot be saved (${issue?.path?.join('.') || 'class_rule'}: ${issue?.message ?? 'invalid'})`, 400)
      }
      patch.class_rule = merged.data
    }

    if (input.name !== undefined) {
      // Another group at this studio with the same name in any case. The
      // group itself is excluded, so re-casing its own name is allowed.
      const { data: clash, error: clashError } = await db
        .from('shelly_groups')
        .select('id')
        .eq('location_id', locationId)
        .neq('id', group.id)
        .ilike('name', escapeLikePattern(input.name))
        .limit(1)
      if (clashError) {
        logError(MODULE, 'group name check failed', { locationId, groupId: group.id, error: clashError.message })
        return bad('Could not save the group', 500)
      }
      if (clash?.length) return bad(NAME_TAKEN, 409, { code: 'name_taken' })
    }

    const { data: row, error } = await db
      .from('shelly_groups')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', group.id)
      .eq('location_id', locationId)
      .select(GROUP_COLUMNS)
      // A zero-row UPDATE is not an error in PostgREST: the row was deleted
      // between the load and the write.
      .maybeSingle()
    if (error) {
      if (error.code === '23505') return bad(NAME_TAKEN, 409, { code: 'name_taken' })
      logError(MODULE, 'group update failed', { locationId, groupId: group.id, code: error.code, error: error.message })
      return bad('Could not save the group', 500)
    }
    if (!row) return notFound()

    const disabled = managed(group) && !managed(row)
    return NextResponse.json({
      success: true,
      group: publicGroup(row),
      ...(disabled ? { notice: GROUP_DISABLE_NOTICE } : {}),
    })
  },
)

export const DELETE = withAuth({ permission: 'device_control' }, async ({ db, locationId, params }) => {
  const loaded = await loadGroup(db, locationId, params?.id)
  if (!loaded.ok) {
    if (loaded.status === 404) return notFound()
    logError(MODULE, 'group read failed', { locationId, error: loaded.error })
    return bad('Could not load this group', 500)
  }
  const { error } = await db
    .from('shelly_groups')
    .delete()
    .eq('id', loaded.group.id)
    .eq('location_id', locationId)
  if (error) {
    logError(MODULE, 'group delete failed', { locationId, groupId: loaded.group.id, error: error.message })
    return bad('Could not remove the group', 500)
  }
  return NextResponse.json({ success: true, message: GROUP_DELETED_MESSAGE })
})
