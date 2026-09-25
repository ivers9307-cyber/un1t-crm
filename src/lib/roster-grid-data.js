// src/lib/roster-grid-data.js
//
// GRID.1 — the ONE server read behind the coach-by-day grid.
//
// ROWS: the studio's team (profile_locations at the studio, profiles.active IS
// NOT FALSE, not tombstoned: mig 626's predicate) PLUS anyone holding a live
// shift at this studio that week who is no longer on it (deactivated, moved,
// or a tombstone keeping history), so the grid never loses a shift the Days
// view shows.
//
// SHIFTS: every live assignment of those people from the Sunday before the
// week to the Monday after (a rest gap reaches one day either side), at this
// studio and at the OTHER studios of the SAME organisation (siblingLocationIds,
// ORGSCOPE.1). The embedded filter is the boundary; every row is re-checked
// against it afterwards, like the working-time reader, so a studio of another
// organisation is dropped even if it comes back.
//
// PAY NEVER ENTERS. profiles is read BY NAME for id, full_name, active,
// deleted_at, employment_type and contracted_hours_per_week (CLAUDE.md: name
// your columns; profiles still carries the pay columns). Contracted hours are
// hours, not pay: STAFF_PICKER_FIELDS has shipped them to every role since
// ROSTER-FIX.6c. They are returned for employees only. profile_compensation is
// NOT read. The profiles copy (deprecated by mig 152, dual-written, REVOKEd
// from the browser roles by mig 153b) is the one the Weekly hours notice, the
// FTE bars and payroll read, and one screen must not show two contracts for
// one person. The phase-3 drop of that column moves all of them together.
//
// COST: three reads in parallel (the team, paged; this studio's shifts, paged; the
// two small locations reads in siblingLocationIds), then profiles (200 ids a
// query), then the other studios' shifts for the grid's people (paged, 200
// ids a query).
//
// NEVER THROWS. A failed team, profiles or this-studio read is an error with
// NO grid (the route answers 500, never an empty grid). Unreadable sibling
// studios, or a failed read of their shifts, narrow the grid to this studio
// and set cross_studio_checked false; they never widen it.

import { isLiveAssignment } from './roster'
import { siblingLocationIds } from './sibling-locations'
import { addDaysISO } from './dublin-time'
import { logWarn } from './log'
import { EMPLOYEE_TYPE } from '@shared/working-time'
import { shiftKindOf } from '@shared/shift-kind'

const PAGE = 1000
const CHUNK = 200

function chunks(list) {
  const out = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

// One paged read of assignments with their block, template and studio.
// `narrow` adds who and where; the window is always [from, to]. The select is
// a LITERAL so check:select-columns resolves every column against the schema.
async function readShifts(db, narrow, from, to) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await narrow(
      db.from('shift_assignments')
        .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name, start_time, end_time, kind), locations(name))'),
    )
      .gte('shift_blocks.block_date', from)
      .lte('shift_blocks.block_date', to)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { rows: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

// The studio's team: every profile_locations row at the studio, paged (a
// team never nears 1,000 today, but the cap is silent when it is reached).
async function readTeam(db, locationId) {
  const ids = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id')
      .eq('location_id', locationId)
      .order('profile_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { ids: null, error }
    for (const l of data || []) if (l?.profile_id) ids.push(l.profile_id)
    if (!data || data.length < PAGE) break
  }
  return { ids, error: null }
}

function flatten(a, locationId) {
  const b = a.shift_blocks
  return {
    assignment_id: a.id,
    profile_id: a.profile_id,
    status: a.status ?? null,
    block_id: b.id,
    block_date: b.block_date,
    location_id: b.location_id,
    location_name: b.locations?.name ?? null,
    here: b.location_id === locationId,
    kind: shiftKindOf(b),
    name: b.shift_templates?.name || 'Shift',
    start_time: b.start_time ?? null,
    end_time: b.end_time ?? null,
    start_time_override: a.start_time_override ?? null,
    end_time_override: a.end_time_override ?? null,
    shift_templates: { start_time: b.shift_templates?.start_time ?? null, end_time: b.shift_templates?.end_time ?? null },
  }
}

// Employees only: a contractor's column may still hold mig 012's default 40.
function contractedHoursOf(p) {
  if (p?.employment_type !== EMPLOYEE_TYPE || p.contracted_hours_per_week == null) return null
  const n = Number(p.contracted_hours_per_week)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, weekStart: string }} opts  weekStart is the week's MONDAY
 * @returns {Promise<{
 *   data: null | {
 *     week_start: string, week_end: string,
 *     members: Array<{ profile_id, full_name, employment_type, contracted_hours, member }>,
 *     shifts: Array<{ assignment_id, profile_id, status, block_id, block_date, location_id,
 *       location_name, here, kind, name, start_time, end_time, start_time_override,
 *       end_time_override, shift_templates }>,
 *     cross_studio_checked: boolean,
 *   },
 *   error: null | { message: string },
 * }>}
 */
export async function loadRosterGrid(db, { locationId, weekStart } = {}) {
  const fail = (error) => ({ data: null, error: { message: error?.message || 'grid read failed' } })
  if (!locationId || !weekStart) return fail({ message: 'location and week are required' })
  const weekEnd = addDaysISO(weekStart, 6)
  const from = addDaysISO(weekStart, -1)
  const to = addDaysISO(weekStart, 7)
  const inWeek = (d) => d >= weekStart && d <= weekEnd

  try {
    const [team, hereRead, siblings] = await Promise.all([
      readTeam(db, locationId),
      readShifts(db, (q) => q.eq('shift_blocks.location_id', locationId), from, to),
      siblingLocationIds(db, locationId),
    ])
    if (team.error) return fail(team.error)
    if (hereRead.error) return fail(hereRead.error)

    const teamIds = new Set(team.ids)
    const here = hereRead.rows.filter((a) => a?.profile_id && a.shift_blocks?.location_id === locationId && isLiveAssignment(a))
    const heldHere = new Set(here.filter((a) => inWeek(a.shift_blocks.block_date)).map((a) => a.profile_id))

    const ids = [...new Set([...teamIds, ...heldHere])]
    const profiles = new Map()
    for (const slice of chunks(ids)) {
      const { data, error } = await db
        .from('profiles')
        .select('id, full_name, active, deleted_at, employment_type, contracted_hours_per_week')
        .in('id', slice)
      if (error) return fail(error)
      for (const p of data || []) if (p?.id) profiles.set(p.id, p)
    }

    const members = []
    for (const id of ids) {
      const p = profiles.get(id)
      const onTeam = teamIds.has(id) && Boolean(p) && p.active !== false && !p.deleted_at
      if (!onTeam && !heldHere.has(id)) continue
      members.push({
        profile_id: id,
        full_name: p?.full_name ?? null,
        employment_type: p?.employment_type ?? null,
        contracted_hours: contractedHoursOf(p),
        member: onTeam,
      })
    }
    const rowIds = members.map((m) => m.profile_id)
    const rowSet = new Set(rowIds)

    let crossStudioChecked = !siblings?.error
    if (siblings?.error) {
      logWarn('roster-grid', 'sibling studios unreadable; the grid counts this studio only', { locationId, err: siblings.error.message })
    }
    const siblingIds = (siblings?.ids || []).filter((id) => id && id !== locationId)
    let elsewhere = []
    if (crossStudioChecked && siblingIds.length > 0 && rowIds.length > 0) {
      for (const slice of chunks(rowIds)) {
        const res = await readShifts(db, (q) => q.in('profile_id', slice).in('shift_blocks.location_id', siblingIds), from, to)
        if (res.error) {
          logWarn('roster-grid', "the other studios' shifts could not be read; the grid counts this studio only", { locationId, err: res.error.message })
          crossStudioChecked = false
          elsewhere = []
          break
        }
        elsewhere.push(...res.rows)
      }
    }
    const siblingSet = new Set(siblingIds)
    const shifts = [
      ...here,
      ...elsewhere.filter((a) => siblingSet.has(a?.shift_blocks?.location_id) && isLiveAssignment(a)),
    ]
      .filter((a) => rowSet.has(a.profile_id))
      .map((a) => flatten(a, locationId))

    return {
      data: { week_start: weekStart, week_end: weekEnd, members, shifts, cross_studio_checked: crossStudioChecked },
      error: null,
    }
  } catch (e) {
    return fail({ message: e?.message || 'grid read threw' })
  }
}
