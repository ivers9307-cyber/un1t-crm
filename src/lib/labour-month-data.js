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
//   salary basis  = for SALARIED people only: profile_locations and published
//                   shift_assignments at ANY studio, by profile id (review 1:
//                   a salary is split across every organisation, and this
//                   one is charged only its share).
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
import {
  labourMonthWindow, labourShiftRows, buildLabourMonth, isSalaried, salaryBasisFrom,
} from './labour-month-model'

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

  // Both in parallel, each judged on its own so a failure is logged as what
  // actually failed (review nit: a memberships failure read as "the roster").
  const [blocksRes, linksRes] = await Promise.allSettled([
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
  if (blocksRes.status === 'rejected') return failed('the roster', blocksRes.reason)
  if (linksRes.status === 'rejected') return failed('studio memberships', linksRes.reason)
  const blocks = blocksRes.value
  const links = linksRes.value

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

  // Review 1 — a salary is split over the person's studios in EVERY
  // organisation, and this organisation is charged only its share. So for the
  // salaried people only: their links and published shifts anywhere, by
  // profile id. These rows never reach the view model; they only weight the
  // split. A failed read is an error: this organisation alone would otherwise
  // be charged a whole salary shared with another.
  const salaried = ids.filter((id) => isSalaried(people.get(id)))
  let salaryBasis = new Map()
  if (salaried.length > 0) {
    try {
      const allLinks = []
      const assignments = []
      for (let i = 0; i < salaried.length; i += ID_CHUNK) {
        const slice = salaried.slice(i, i + ID_CHUNK)
        const [l, a] = await Promise.all([
          selectAll((from, to) => db
            .from('profile_locations')
            .select('profile_id, location_id, locations:location_id ( active, is_host_anchor )')
            .in('profile_id', slice)
            .order('profile_id', { ascending: true })
            .order('location_id', { ascending: true })
            .range(from, to)),
          selectAll((from, to) => db
            .from('shift_assignments')
            .select('id, profile_id, start_time_override, end_time_override, status, shift_blocks!inner ( id, location_id, block_date, start_time, end_time, rosters:roster_id ( status ), shift_templates ( start_time, end_time ) )')
            .in('profile_id', slice)
            .gte('shift_blocks.block_date', period.startDate)
            .lte('shift_blocks.block_date', period.endDate)
            .order('id', { ascending: true })
            .range(from, to)),
        ])
        allLinks.push(...l)
        assignments.push(...a)
      }
      const anywhere = labourShiftRows(assignments.map(({ shift_blocks: b, ...a }) => ({ ...b, shift_assignments: [a] })))
      salaryBasis = salaryBasisFrom({ ids: salaried, rows: anywhere, links: allLinks })
    } catch (e) {
      return failed("salaried staff's studios", e)
    }
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

  return { data: buildLabourMonth({ period, nowMs, studios: shown, rows, people, memberships, revenue, salaryBasis }) }
}
