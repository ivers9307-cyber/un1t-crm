// LEAVEBAL.1 — one studio's leave balances in one read, for the manager's
// Schedule › Leave balances screen (GET /api/schedule/allowances/team).
//
// One row per ACTIVE, non-deleted member of staff at the studio
// (profile_locations → profiles, tombstones excluded): the year's holiday
// allowance in DAYS (total, carried over, used, pending, remaining) and the
// year's time-in-lieu balance in HOURS. The two are never folded together:
// lieu is hours, FTE only; the allowance is days.
//
// The figures are the SAME ones GET /api/schedule/allowances gives for one
// person, read in batches instead of once per person:
//   • holiday: the staff_allowances row, or before one exists the contract
//     entitlement (profile_compensation, entitlementDays), used 0, carried 0;
//     remaining = total + carried − used (pending is reported beside it,
//     never subtracted, exactly as the per-person route does).
//   • a contractor has no holiday allowance and earns no lieu: both n/a.
//   • lieu: lieuBalanceFrom over the person's ledger rows dated in the year
//     (every studio, as the per-person ledger reads it).
//
// WHAT A FAILURE MEANS. The staff list is the only read that fails the
// request. Every other read failing makes ITS figure unknown (null, named in
// `unreadable`), never 0: a 0 lieu balance would tell a manager nobody is
// owed time off. Reads are chunked by id and paged past the 1,000-row cap.

import { excludeTombstones } from '@/lib/staff-tombstone'
import { entitlementDays } from '@/lib/time-off-leave'
import { readLieuLedgerForProfiles } from '@/lib/lieu-credits'
import { lieuBalanceFrom, round2 } from '@/lib/lieu-rules'

const PAGE = 1000
const ID_CHUNK = 200

export const TEAM_LEAVE_PARTS = Object.freeze(['allowances', 'entitlements', 'pending', 'lieu'])

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function pageAll(make) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1)
    if (error) return { rows: [], error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

/** Reads `make(idsPart, from, to)` for every chunk of ids, paged. */
async function readByIds(ids, make) {
  const rows = []
  for (const part of chunk(ids, ID_CHUNK)) {
    const res = await pageAll((a, b) => make(part, a, b))
    if (res.error) return { rows: [], error: res.error }
    rows.push(...res.rows)
  }
  return { rows, error: null }
}

/**
 * Active, non-deleted staff at one studio: { id, full_name, employment_type }.
 * @returns {Promise<{ staff: Array<object>, error: object|null }>}
 */
export async function readStudioStaff(db, locationId) {
  const links = await pageAll((a, b) => db.from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
    .order('profile_id')
    .range(a, b))
  if (links.error) return { staff: [], error: links.error }
  const ids = [...new Set(links.rows.map((r) => r.profile_id).filter(Boolean))]
  if (ids.length === 0) return { staff: [], error: null }
  const res = await readByIds(ids, (part, a, b) => excludeTombstones(
    db.from('profiles')
      .select('id, full_name, employment_type')
      .in('id', part)
      .eq('active', true),
  ).order('id').range(a, b))
  if (res.error) return { staff: [], error: res.error }
  return { staff: res.rows, error: null }
}

/**
 * Pure: the screen's rows from what was read. A part passed as null was
 * unreadable and its figures come back null.
 *
 * @param {object} args
 * @param {Array<{id:string, full_name:string|null, employment_type:string|null}>} args.staff
 * @param {Array<object>|null} args.allowances  staff_allowances rows for the year
 * @param {Array<object>|null} args.entitlements  profile_compensation rows
 * @param {Array<object>|null} args.pending  pending holiday time_off_requests rows
 * @param {Array<object>|null} args.lieuRows  staff_lieu_credits rows dated in the year
 */
export function buildTeamLeaveRows({ staff, allowances, entitlements, pending, lieuRows }) {
  const allowanceBy = allowances ? new Map(allowances.map((r) => [r.profile_id, r])) : null
  const entitlementBy = entitlements ? new Map(entitlements.map((r) => [r.profile_id, r.annual_leave_entitlement])) : null
  const pendingBy = new Map()
  for (const r of pending || []) pendingBy.set(r.profile_id, (pendingBy.get(r.profile_id) || 0) + Number(r.total_days || 0))
  const lieuBy = new Map()
  for (const r of lieuRows || []) {
    if (!lieuBy.has(r.profile_id)) lieuBy.set(r.profile_id, [])
    lieuBy.get(r.profile_id).push(r)
  }

  const rows = (staff || []).map((p) => {
    const contractor = p.employment_type === 'contractor'
    const base = {
      profile_id: p.id,
      full_name: p.full_name || 'Unnamed',
      employment_type: p.employment_type || null,
      not_applicable: contractor,
    }
    if (contractor) return { ...base, holiday: null, pending_days: null, lieu: null }

    let holiday = null
    const stored = allowanceBy ? allowanceBy.get(p.id) : undefined
    if (stored) {
      const total = Number(stored.total_days)
      const carried = Number(stored.carried_over)
      const used = Number(stored.used_days)
      holiday = { stored: true, total_days: total, carried_over: carried, used_days: used, remaining: round2(total + carried - used) }
    } else if (allowanceBy && entitlementBy) {
      // No row yet: the contract entitlement, as the per-person GET answers.
      const total = entitlementDays(entitlementBy.get(p.id))
      holiday = { stored: false, total_days: total, carried_over: 0, used_days: 0, remaining: total }
    }

    const pendingDays = pending ? round2(pendingBy.get(p.id) || 0) : null
    const lieu = lieuRows ? lieuBalanceFrom(lieuBy.get(p.id) || []) : null
    return { ...base, holiday, pending_days: pendingDays, lieu }
  })
  rows.sort((a, b) => a.full_name.localeCompare(b.full_name))
  return rows
}

/**
 * The whole screen for one studio and year.
 * @returns {Promise<{ rows: Array<object>|null, unreadable: string[], error: object|null }>}
 *   `error` only when the staff list itself could not be read.
 */
export async function readTeamLeaveBalances(db, locationId, year) {
  const y = Number(year)
  const { staff, error } = await readStudioStaff(db, locationId)
  if (error) return { rows: null, unreadable: [], error }

  const ids = staff.map((p) => p.id)
  const unreadable = []
  if (ids.length === 0) return { rows: [], unreadable, error: null }

  const [allowances, entitlements, pending, lieu] = await Promise.all([
    readByIds(ids, (part, a, b) => db.from('staff_allowances')
      .select('profile_id, total_days, used_days, carried_over')
      .in('profile_id', part)
      .eq('year', y)
      .order('profile_id')
      .range(a, b)),
    readByIds(ids, (part, a, b) => db.from('profile_compensation')
      .select('profile_id, annual_leave_entitlement')
      .in('profile_id', part)
      .order('profile_id')
      .range(a, b)),
    // The rows getPendingHolidayDays sums: type holiday, raw status pending,
    // attributed to the year their start_date falls in.
    readByIds(ids, (part, a, b) => db.from('time_off_requests')
      .select('id, profile_id, total_days')
      .in('profile_id', part)
      .eq('type', 'holiday')
      .eq('status', 'pending')
      .gte('start_date', `${y}-01-01`)
      .lte('start_date', `${y}-12-31`)
      .order('id')
      .range(a, b)),
    readLieuLedgerForProfiles(db, ids, { from: `${y}-01-01`, to: `${y}-12-31` }),
  ])

  const ok = (part, res) => {
    if (!res.error) return res.rows
    unreadable.push(part)
    console.error(`[allowances/team] ${part} unreadable`, res.error.message)
    return null
  }
  const rows = buildTeamLeaveRows({
    staff,
    allowances: ok('allowances', allowances),
    entitlements: ok('entitlements', entitlements),
    pending: ok('pending', pending),
    lieuRows: ok('lieu', lieu),
  })
  return { rows, unreadable, error: null }
}
