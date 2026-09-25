// src/lib/labour-month-data.js
//
// LABOUR.1 — the reads behind the owner's "Labour against revenue" block.
// Service-role reads: NO RLS applies (CLAUDE.md), so every read is scoped here.
//
//   organisation  = the active studio + siblingLocationIds (ORGSCOPE.1); the
//                   studios SHOWN are clipped to it, whatever the caller passed.
//   roster        = shift_blocks at every studio of the organisation in the
//                   Dublin month, with roster status, template times and
//                   assignments; paged past the 1,000-row cap.
//   memberships   = profile_locations at those studios (unrostered salaries).
//   people        = profiles by id, NAMED columns only (profiles still carries
//                   pay columns: CLAUDE.md "name your columns").
//   pay           = profile_compensation (mig 152, the canonical copy) by id.
//   revenue       = the Studio scorecard's own fetchMrr, per studio shown.
//
// Never throws. A failed organisation, roster, membership, profiles or pay read
// returns { error } (logged): a partial labour figure would read as a real one.
// A failed MRR read degrades that one studio to "unavailable" (its ratio is
// visibly missing, never 0%).
//
// Cost: two small locations reads, then the roster and memberships in parallel,
// then profiles (chunked by 200 ids), the pay read, and one MRR read per studio
// shown. Two studios and ~20 people today: one page each.

import { selectAll } from './select-all'
import { siblingLocationIds } from './sibling-locations'
import { getCompensationForProfiles } from './profile-compensation'
import { logError, logWarn } from './log'
import { fetchMrr } from '@shared/studio-kpis'
import { labourMonthWindow, labourShiftRows, buildLabourMonth } from './labour-month-model'

const ID_CHUNK = 200

/**
 * @param {object} db  service-role client
 * @param {{ activeLocationId: string, studios: {id:string,name:string}[], nowMs?: number }} args
 *   studios: from labourStudiosFor(user) — the caller has already decided
 *   the viewer is an owner there.
 * @returns {Promise<{ data: object } | { error: string }>}
 */
export async function loadLabourMonth(db, { activeLocationId, studios, nowMs = Date.now() } = {}) {
  if (!activeLocationId || !Array.isArray(studios) || studios.length === 0) {
    return { error: 'No studio to report on' }
  }
  const period = labourMonthWindow(nowMs)
  const failed = (what, err) => {
    logError('labour-month', `${what} read failed`, {
      err: err?.message || String(err), location_id: activeLocationId, month: period.month,
    })
    return { error: `Could not read ${what}` }
  }

  const siblings = await siblingLocationIds(db, activeLocationId)
  if (siblings.error) return failed("the organisation's studios", siblings.error)
  const orgStudioIds = [activeLocationId, ...siblings.ids]
  const shown = studios.filter((s) => s?.id && orgStudioIds.includes(s.id))
  if (shown.length === 0) return { error: 'No studio to report on' }

  let blocks
  let links
  try {
    ;[blocks, links] = await Promise.all([
      selectAll((from, to) => db
        .from('shift_blocks')
        .select('id, location_id, block_date, start_time, end_time, rosters:roster_id ( status ), shift_templates ( start_time, end_time, kind ), shift_assignments ( id, profile_id, start_time_override, end_time_override, status )')
        .in('location_id', orgStudioIds)
        .gte('block_date', period.startDate)
        .lte('block_date', period.endDate)
        .order('id', { ascending: true })
        .range(from, to)),
      selectAll((from, to) => db
        .from('profile_locations')
        .select('profile_id, location_id')
        .in('location_id', orgStudioIds)
        .order('profile_id', { ascending: true })
        .order('location_id', { ascending: true })
        .range(from, to)),
    ])
  } catch (e) {
    return failed('the roster', e)
  }

  const rows = labourShiftRows(blocks)
  const memberships = new Map()
  for (const l of links || []) {
    if (!l?.profile_id) continue
    if (!memberships.has(l.profile_id)) memberships.set(l.profile_id, new Set())
    memberships.get(l.profile_id).add(l.location_id)
  }

  const ids = [...new Set([...rows.map((r) => r.profile_id), ...memberships.keys()])]
  const people = new Map()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db.from('profiles').select('id, full_name, active, deleted_at, employment_type').in('id', slice)
    if (error) return failed('staff', error)
    for (const p of data || []) {
      people.set(p.id, {
        full_name: p.full_name, employment_type: p.employment_type,
        active: p.active, deleted_at: p.deleted_at,
        annual_salary: null, hourly_rate: null,
      })
    }
  }

  let comp
  try {
    comp = await getCompensationForProfiles(db, ids)
  } catch (e) {
    return failed('pay', e)
  }
  for (const [id, c] of comp) {
    const p = people.get(id)
    if (!p) continue
    p.annual_salary = c.annual_salary
    p.hourly_rate = c.hourly_rate
  }

  const revenue = new Map(await Promise.all(shown.map(async (s) => {
    try {
      const res = await fetchMrr(db, s.id)
      if (res?.success) return [s.id, res.data]
      logWarn('labour-month', 'MRR read failed', { location_id: s.id, err: res?.error })
    } catch (e) {
      logWarn('labour-month', 'MRR read threw', { location_id: s.id, err: e?.message })
    }
    return [s.id, null]
  })))

  return { data: buildLabourMonth({ period, nowMs, studios: shown, rows, people, memberships, revenue }) }
}
