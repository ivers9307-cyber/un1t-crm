// SHELLYGROUPS.5 — the tenant-scoped group loader every /api/shelly/groups/[id]
// route shares, and the device → group read the run-now and toggle routes need.
//
// Same rules as device-load.js, for the same reasons: the WHERE clause is the
// tenant boundary (service-role clients bypass RLS), a malformed id and a
// foreign one answer the SAME 404 (a 400/404 split is an enumeration oracle),
// and "we could not look" (500) is never reported as "not yours" (404).

import { uuidLike } from '@/lib/schemas'
import { GROUP_COLUMNS } from './effective'

/**
 * One group, scoped to the caller's location.
 * @returns {{ok: true, group} | {ok: false, status: 404} | {ok: false, status: 500, error}}
 */
export async function loadGroup(db, locationId, id) {
  if (!uuidLike.safeParse(id).success) return { ok: false, status: 404 }
  const { data, error } = await db
    .from('shelly_groups')
    .select(GROUP_COLUMNS)
    .eq('id', id)
    .eq('location_id', locationId)
    // 0 rows is the ordinary "not yours / not there" answer.
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404 }
  return { ok: true, group: data }
}

/**
 * The group a device follows, read at the DEVICE's location.
 *
 * An ungrouped device answers `group: null` without a read. A grouped device
 * whose group cannot be read — the read failed, or the row is gone (a delete
 * racing this request; the FK's SET NULL lands on the device row a moment
 * later) — answers ok:false. The caller must REFUSE rather than fall back to
 * the device's own schedule: joining a group cleared that schedule, so "run it
 * on its own" would be planning against an empty schedule and could force the
 * relay off (the group_unavailable ruling).
 *
 * @returns {{ok: true, group: object|null} | {ok: false, reason: 'missing'|'db_error', error?}}
 */
export async function loadDeviceGroup(db, device) {
  if (device?.group_id == null) return { ok: true, group: null }
  const { data, error } = await db
    .from('shelly_groups')
    .select(GROUP_COLUMNS)
    .eq('id', device.group_id)
    .eq('location_id', device.location_id)
    .maybeSingle()
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data) return { ok: false, reason: 'missing' }
  return { ok: true, group: data }
}

/**
 * The group as a response carries it: GROUP_COLUMNS minus `last_applied`, the
 * engine's exactly-once bookkeeping, which no screen reads and whose shape is
 * not a contract.
 */
export function publicGroup(group) {
  if (!group) return group
  const { last_applied: _lastApplied, ...rest } = group
  return rest
}
