// LEAVE.2 — the rules leave is judged by, shared by the time-off routes and
// the approvals provider.
//
//   • Leave covers the PERSON, not a studio. `time_off_requests.location_id`
//     stays "the studio it was filed at", but every reader that asks "who is
//     off at studio X" asks for leave filed at X OR taken by anyone who belongs
//     to X (leaveScopeOrFilter). A coach at both studios filing from Hatch is
//     off at Stillorgan too.
//   • Who may decide it: anyone holding the per-location time-off approval
//     permission (APPROVAL_CATEGORY_PERMISSION.time_off) at the studio it was
//     filed at or at any studio the requester belongs to.
//   • Holiday balance: the allowance row, or — before the first approved
//     holiday has created one — the person's contract entitlement
//     (profile_compensation.annual_leave_entitlement, mig 152), 20 only when
//     that is null.
//   • Shift clashes: live assignments of the requester, at ANY studio, on a
//     day the leave covers, from today on. Past shifts are history (worked or
//     not, payroll has already read them), so they are neither counted nor
//     offered for unassigning.

import {
  resolvePermission,
  mergeTemplates,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  APPROVAL_CATEGORY_PERMISSION,
} from '@shared/permissions'
import { hasPermissionForLocation } from '@/lib/permissions'
import { isLiveAssignment } from '@/lib/roster'
import { nonWorkingDateSet } from '@/lib/time-off-days'
import { uncoveredHolidayYears } from '@/lib/bank-holidays'
import { logWarn } from '@/lib/log'

export const TIME_OFF_APPROVE_PERMISSION = APPROVAL_CATEGORY_PERMISSION.time_off
export const DEFAULT_LEAVE_ENTITLEMENT = 20
const PAGE = 1000

// ── Memberships ───────────────────────────────────────────────────────────

/** Every studio a profile belongs to. */
export async function getProfileLocationIds(db, profileId) {
  const { data, error } = await db
    .from('profile_locations')
    .select('location_id')
    .eq('profile_id', profileId)
  if (error) return { ids: [], error }
  return { ids: [...new Set((data || []).map((r) => r.location_id).filter(Boolean))], error: null }
}

/** Every profile that belongs to any of these studios. */
export async function getLocationMemberIds(db, locationIds) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  if (ids.length === 0) return { ids: [], error: null }
  const { data, error } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', ids)
  if (error) return { ids: [], error }
  return { ids: [...new Set((data || []).map((r) => r.profile_id).filter(Boolean))], error: null }
}

/**
 * PostgREST `.or()` expression for "leave that shows at these studios":
 * filed there, or taken by someone who belongs there. Every id comes from our
 * own tables (uuids), so inlining is safe. Pure.
 */
export function leaveScopeOrFilter(locationIds, memberIds) {
  const locs = [...new Set((locationIds || []).filter(Boolean))]
  const members = [...new Set((memberIds || []).filter(Boolean))]
  const parts = []
  if (locs.length) parts.push(`location_id.in.(${locs.join(',')})`)
  if (members.length) parts.push(`profile_id.in.(${members.join(',')})`)
  return parts.join(',')
}

// ── Approvers ─────────────────────────────────────────────────────────────

/**
 * Can this user decide (approve/reject) a request filed at `filedLocationId`
 * by someone who belongs to `requesterLocationIds`? Per-location permission,
 * never the active studio's role.
 */
export function canDecideTimeOff(user, filedLocationId, requesterLocationIds = []) {
  if (!user) return false
  if (user.profileRole === 'master') return true
  // user.locations — the same list getUserLocationIds reads; inlined so this
  // module (imported by roster-publish) does not pull in the auth/cookies stack.
  const mine = new Set((user.locations || []).map((l) => l.id))
  const candidates = [...new Set([filedLocationId, ...(requesterLocationIds || [])].filter(Boolean))]
  return candidates.some((id) => mine.has(id) && hasPermissionForLocation(user, id, TIME_OFF_APPROVE_PERMISSION))
}

/**
 * Who can approve time off at these studios — pure. Same tier order as
 * hasPermissionForLocation, resolved per assignment row (the
 * email-inbound-push recipient pattern).
 *
 * @param {object} args
 * @param {Array} args.links  profile_locations rows: { profile_id, location_id,
 *   role, permissions, profiles: { active, role, employment_type } }
 * @param {Array} args.templates  location_role_permissions rows
 * @param {Object<string, object|null>} args.featuresByLocation  location id →
 *   locations.features (missing ⇒ gate open, as for a null location)
 */
export function timeOffApproverIdsFrom({ links, templates, featuresByLocation }) {
  const rowFor = (locationId, role, emp) =>
    (templates || []).find((t) => t.location_id === locationId && t.role === role && t.employment_type === emp)?.permissions || null

  const out = new Set()
  for (const l of links || []) {
    if (!l?.profiles?.active) continue
    const isMaster = l.profiles.role === 'master'
    const features = featuresByLocation?.[l.location_id]
    const ok = resolvePermission({
      role: isMaster ? 'master' : l.role,
      location: features ? { features } : null,
      permissions: l.permissions || {},
      roleTemplate: mergeTemplates(
        rowFor(l.location_id, l.role, 'all'),
        l.profiles.employment_type ? rowFor(l.location_id, l.role, l.profiles.employment_type) : null,
      ),
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: TIME_OFF_APPROVE_PERMISSION,
    })
    if (ok) out.add(l.profile_id)
  }
  return [...out]
}

/**
 * Everyone who can approve time off at any of these studios. A failed
 * membership read returns the error (the caller decides; guessing would
 * over-notify). Template/feature reads only narrow, so they degrade to the
 * code defaults.
 */
export async function resolveTimeOffApproverIds(db, locationIds) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  if (ids.length === 0) return { ids: [], error: null }
  const [linksRes, tplRes, locRes] = await Promise.all([
    db.from('profile_locations')
      .select('profile_id, location_id, role, permissions, profiles!inner(id, active, role, employment_type)')
      .in('location_id', ids),
    db.from('location_role_permissions')
      .select('location_id, role, employment_type, permissions')
      .in('location_id', ids),
    db.from('locations').select('id, features').in('id', ids),
  ])
  if (linksRes.error) return { ids: [], error: linksRes.error }
  const featuresByLocation = {}
  if (!locRes.error) for (const l of locRes.data || []) featuresByLocation[l.id] = l.features || null
  return {
    ids: timeOffApproverIdsFrom({
      links: linksRes.data || [],
      templates: tplRes.error ? [] : (tplRes.data || []),
      featuresByLocation,
    }),
    error: null,
  }
}

// ── Employment + entitlement ──────────────────────────────────────────────

/** profiles.employment_type for one person ('fte' | 'contractor'). */
export async function getEmploymentType(db, profileId) {
  const { data, error } = await db
    .from('profiles')
    .select('employment_type')
    .eq('id', profileId)
    .maybeSingle()
  if (error) return { employmentType: null, error }
  return { employmentType: data?.employment_type || null, error: null }
}

/** A stored entitlement → days; null/blank/garbage → the 20-day default. Pure. */
export function entitlementDays(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_LEAVE_ENTITLEMENT
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAVE_ENTITLEMENT
}

/**
 * The person's contract entitlement. Read from profile_compensation — mig 152
 * moved it there and marked `profiles.annual_leave_entitlement` DEPRECATED
 * (its SELECT is revoked and it is due to be dropped), so this does not fall
 * back to the old column.
 */
export async function getLeaveEntitlement(db, profileId) {
  const { data, error } = await db
    .from('profile_compensation')
    .select('annual_leave_entitlement')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) return { days: null, error }
  return { days: entitlementDays(data?.annual_leave_entitlement), error: null }
}

/**
 * This year's holiday allowance: the stored row, or the unstored default
 * seeded from the entitlement. `exists` says which.
 */
export async function getHolidayAllowance(db, profileId, year) {
  // (profile_id, year) is uniquely indexed; 0 rows is the not-yet-seeded case.
  const { data, error } = await db
    .from('staff_allowances')
    .select('id, total_days, used_days, carried_over')
    .eq('profile_id', profileId)
    .eq('year', year)
    .maybeSingle()
  if (error) return { allowance: null, error }
  if (data) {
    return {
      allowance: {
        exists: true,
        total_days: Number(data.total_days),
        used_days: Number(data.used_days),
        carried_over: Number(data.carried_over),
      },
      error: null,
    }
  }
  const ent = await getLeaveEntitlement(db, profileId)
  if (ent.error) return { allowance: null, error: ent.error }
  return {
    allowance: { exists: false, total_days: ent.days, used_days: 0, carried_over: 0 },
    error: null,
  }
}

/**
 * Make sure the allowance row exists BEFORE a holiday is approved, seeded from
 * the entitlement. The approval trigger (mig 011 update_holiday_allowance)
 * inserts a 20-day row when none exists and only increments on conflict, so
 * pre-seeding is what makes the entitlement stick without depending on mig 616.
 * Existing rows are never touched.
 */
export async function ensureHolidayAllowanceRow(db, profileId, year) {
  const { allowance, error } = await getHolidayAllowance(db, profileId, year)
  if (error) return { error }
  if (allowance.exists) return { error: null }
  const { error: insErr } = await db
    .from('staff_allowances')
    .insert({ profile_id: profileId, year, total_days: allowance.total_days, used_days: 0, carried_over: 0 })
  // 23505 — someone else seeded it between the read and the insert. Fine.
  if (insErr && insErr.code !== '23505') return { error: insErr }
  return { error: null }
}

/**
 * HOLIDAYLEAVE.1 — the dates in [startIso, endIso] that cost no holiday
 * allowance at this studio: its country's national bank holidays
 * (bank-holidays.js, static) plus its own location_holidays rows (mig 017).
 *
 * Fails CLOSED like every other read behind the time-off POST: an unreadable
 * list returns the error, never an empty set, because an empty set silently
 * over-charges the allowance (the bug this exists to fix). A request is capped
 * at 366 days by the route, so the closures read cannot reach the 1,000-row
 * select cap and is not paged.
 *
 * Only called for holiday-type requests. A year or country bank-holidays.js
 * has no list for is served (closures only) and logged once, never thrown.
 *
 * @returns {Promise<{ dates: Set<string>|null, error: object|null }>}
 */
export async function getNonWorkingDates(db, locationId, startIso, endIso) {
  // Primary-key lookup; a missing row falls back to Ireland, as
  // GET /api/locations/[id]/holidays does.
  const { data: loc, error: locError } = await db
    .from('locations')
    .select('country')
    .eq('id', locationId)
    .maybeSingle()
  if (locError) return { dates: null, error: locError }

  const { data: custom, error: customError } = await db
    .from('location_holidays')
    .select('date')
    .eq('location_id', locationId)
    .gte('date', startIso)
    .lte('date', endIso)
  if (customError) return { dates: null, error: customError }

  // The static lists end (and do not know every country). Past that, "no
  // national holidays" really means "no list", which is the old over-charge
  // coming back in silence. It is not a reason to refuse leave, so the request
  // is served with the studio's own closures and leaves one trace per call.
  const country = loc?.country || 'IE'
  const years = uncoveredHolidayYears(country, startIso, endIso)
  if (years.length > 0) {
    logWarn('time-off', 'no national bank-holiday list for this holiday request; only the studio\'s own closures were left uncharged', { locationId, country, years })
  }

  return {
    dates: nonWorkingDateSet({ country, customHolidays: custom || [], start: startIso, end: endIso }),
    error: null,
  }
}

// ── Shift clashes ─────────────────────────────────────────────────────────

function flattenAssignment(a) {
  const b = a.shift_blocks || {}
  return {
    id: a.id,
    profile_id: a.profile_id,
    block_id: b.id || a.block_id,
    block_date: b.block_date,
    start_time: b.start_time || null,
    end_time: b.end_time || null,
    location_id: b.location_id || null,
    location_name: b.locations?.name || null,
    template_name: b.shift_templates?.name || null,
    roster_status: b.rosters?.status || null,
  }
}

async function readAssignmentsInRange(db, profileIds, lo, hi, columns) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('shift_assignments')
      .select(columns)
      .in('profile_id', profileIds)
      .gte('shift_blocks.block_date', lo)
      .lte('shift_blocks.block_date', hi)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { rows: [], error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

/** The window of a request that can still clash: [max(start, today), end]. Pure. */
export function clashWindow(request, todayIso) {
  if (!request?.start_date || !request?.end_date) return null
  const lo = todayIso && todayIso > request.start_date ? todayIso : request.start_date
  return lo > request.end_date ? null : { lo, hi: request.end_date }
}

/**
 * Live shifts the requester is rostered on during the leave, from today on,
 * at any studio.
 */
export async function findLeaveClashes(db, request, todayIso) {
  const win = clashWindow(request, todayIso)
  if (!win) return { clashes: [], error: null }
  const { rows, error } = await readAssignmentsInRange(
    db, [request.profile_id], win.lo, win.hi,
    'id, profile_id, block_id, status, shift_blocks!inner(id, block_date, start_time, end_time, location_id, rosters:roster_id(status), shift_templates(name), locations(name))',
  )
  if (error) return { clashes: [], error }
  const clashes = rows
    .filter(isLiveAssignment)
    .map(flattenAssignment)
    .filter((c) => c.block_date >= win.lo && c.block_date <= win.hi)
    .sort((a, b) => (a.block_date + (a.start_time || '')).localeCompare(b.block_date + (b.start_time || '')))
  return { clashes, error: null }
}

/**
 * Pure. request id → number of live shifts it clashes with. Only pending
 * (unexpired) and approved requests can clash; everything else is 0/absent.
 */
export function bucketClashCounts(requests, assignments, todayIso) {
  const byProfile = new Map()
  for (const a of assignments || []) {
    if (!isLiveAssignment(a)) continue
    const date = a.shift_blocks?.block_date || a.block_date
    if (!date) continue
    if (!byProfile.has(a.profile_id)) byProfile.set(a.profile_id, [])
    byProfile.get(a.profile_id).push(date)
  }
  const counts = {}
  for (const r of requests || []) {
    if (r.status !== 'pending' && r.status !== 'approved') continue
    const win = clashWindow(r, todayIso)
    if (!win) continue
    counts[r.id] = (byProfile.get(r.profile_id) || []).filter((d) => d >= win.lo && d <= win.hi).length
  }
  return counts
}

/** One read for a whole list of requests. */
export async function countLeaveClashes(db, requests, todayIso) {
  const open = (requests || []).filter((r) => (r.status === 'pending' || r.status === 'approved') && clashWindow(r, todayIso))
  if (open.length === 0) return { counts: {}, error: null }
  const profileIds = [...new Set(open.map((r) => r.profile_id))]
  const windows = open.map((r) => clashWindow(r, todayIso))
  const lo = windows.map((w) => w.lo).sort()[0]
  const hi = windows.map((w) => w.hi).sort().at(-1)
  const { rows, error } = await readAssignmentsInRange(
    db, profileIds, lo, hi, 'id, profile_id, status, shift_blocks!inner(block_date)',
  )
  if (error) return { counts: {}, error }
  return { counts: bucketClashCounts(open, rows, todayIso), error: null }
}
