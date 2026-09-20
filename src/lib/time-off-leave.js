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
//   • Shift clashes: live assignments of the requester, at any studio OF THE
//     ORGANISATION(S) THE DECIDER ACTS IN (ORGSCOPE.1), on a day the leave
//     covers, from today on. Past shifts are history (worked or not, payroll
//     has already read them), so they are neither counted nor offered for
//     unassigning.

import {
  resolvePermission,
  mergeTemplates,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  APPROVAL_CATEGORY_PERMISSION,
} from '@shared/permissions'
import { hasPermissionForLocation } from '@/lib/permissions'
import { isLiveAssignment } from '@/lib/roster'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import { nonWorkingDateSet, countLeaveDays, splitAtYearEnd } from '@/lib/time-off-days'
import { uncoveredHolidayYears } from '@/lib/bank-holidays'
import { logWarn } from '@/lib/log'
import { siblingLocationIds } from '@/lib/sibling-locations'

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

/**
 * ORGSCOPE.2 — every studio each of these profiles belongs to, in one paged
 * read: Map(profileId → locationId[]). A profile with no rows is absent.
 */
export async function getLocationIdsByProfile(db, profileIds) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const byProfile = new Map()
  if (ids.length === 0) return { byProfile, error: null }
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id, location_id')
      .in('profile_id', ids)
      .order('profile_id', { ascending: true })
      .order('location_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { byProfile: new Map(), error }
    for (const r of data || []) {
      if (!r.profile_id || !r.location_id) continue
      if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
      byProfile.get(r.profile_id).push(r.location_id)
    }
    if (!data || data.length < PAGE) break
  }
  return { byProfile, error: null }
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
 * ORGSCOPE.1 — the studios this user decides the request FROM: the candidates
 * of canDecideTimeOff where they actually hold the permission (master: every
 * candidate). findLeaveClashes scopes to these studios' organisations, so a
 * decider entitled through the person's studio in organisation B is never
 * shown organisation A's roster just because the leave was filed there. Pure.
 */
export function decidingLocationIds(user, filedLocationId, requesterLocationIds = []) {
  if (!user) return []
  const candidates = [...new Set([filedLocationId, ...(requesterLocationIds || [])].filter(Boolean))]
  if (user.profileRole === 'master') return candidates
  const mine = new Set((user.locations || []).map((l) => l.id))
  return candidates.filter((id) => mine.has(id) && hasPermissionForLocation(user, id, TIME_OFF_APPROVE_PERMISSION))
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
 * LEAVEPHONE.1 — `quiet: true` skips that log and nothing else. The leave
 * form's preview asks on every tap of the calendar and is not a request, so it
 * must not write "this holiday request" once per tap; the POST (the default)
 * still leaves its one trace per call.
 *
 * @returns {Promise<{ dates: Set<string>|null, error: object|null }>}
 */
export async function getNonWorkingDates(db, locationId, startIso, endIso, { quiet = false } = {}) {
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
  if (years.length > 0 && !quiet) {
    logWarn('time-off', 'no national bank-holiday list for this holiday request; only the studio\'s own closures were left uncharged', { locationId, country, years })
  }

  return {
    dates: nonWorkingDateSet({ country, customHolidays: custom || [], start: startIso, end: endIso }),
    error: null,
  }
}

/**
 * LEAVEPHONE.1 — pure. Is this a REAL calendar date spelt YYYY-MM-DD? The
 * pattern alone lets 2026-02-30 through, and V8 rolls that over to 2 March, so
 * a day loop counts a range nobody asked for. Round-trips through Date.UTC and
 * compares with the input: no local time, so no timezone can move the day.
 * TEMPORARY HOME: a sibling PR adds a shared `isRealCalendarDate` to
 * src/lib/schemas.js; once that is on main, use it here and delete this.
 */
export function isRealIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  // setUTCFullYear: Date.UTC maps years 0-99 onto 1900-1999.
  t.setUTCFullYear(y)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === value
}

/**
 * LEAVEPHONE.1 — THE day count: what a request of this type and range is
 * charged, one segment per calendar year (each year has its own allowance).
 * The time-off POST charges with it and the leave form's preview displays it,
 * so the phone can never show a number the server will not charge. Any change
 * to the rule (HOLIDAYLEAVE.1 added bank holidays + studio closures) lands in
 * both at once.
 *
 * Only `holiday` consults the non-working dates. Fails CLOSED like
 * getNonWorkingDates: an unreadable list is an error, never an empty set
 * (which would over-charge) — and so is a holiday with no studio to ask, which
 * the POST refuses before it ever gets here (HOLIDAYLEAVE.1's "No studio"
 * 400); this is the same rule for any other caller, never a blind Mon-Fri.
 *
 * `quiet` is for a caller that is only ASKING (the preview): same count, no
 * no-holiday-list warning. The POST leaves it off and logs once per call.
 *
 * @returns {Promise<{ segments: Array<{ s: string, e: string, days: number }>, total: number, error: object|null }>}
 */
export async function chargeableLeaveSegments(db, { type, locationId, startIso, endIso, quiet = false }) {
  let nonWorkingDates = null
  if (type === 'holiday') {
    if (!locationId) return { segments: [], total: 0, error: { message: 'No studio to count holiday leave against' } }
    const { dates, error } = await getNonWorkingDates(db, locationId, startIso, endIso, { quiet })
    if (error) return { segments: [], total: 0, error }
    nonWorkingDates = dates
  }
  const segments = splitAtYearEnd(startIso, endIso)
    .map(([s, e]) => ({ s, e, days: countLeaveDays(type, s, e, nonWorkingDates) }))
  return { segments, total: segments.reduce((sum, seg) => sum + seg.days, 0), error: null }
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

async function readAssignmentsInRange(db, profileIds, lo, hi, columns, locationIds = null) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('shift_assignments')
      .select(columns)
      .in('profile_id', profileIds)
    // ORGSCOPE.1 — a caller that SHOWS the rows passes the studios it may show.
    if (locationIds) q = q.in('shift_blocks.location_id', locationIds)
    const { data, error } = await q
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
 * at the deciding studios and their organisations' other studios.
 *
 * ORGSCOPE.1 — a clash row carries the shift's name, times and studio, and
 * nothing keeps a person inside one organisation, so "any studio" is bounded
 * by organisation. `scopeLocationIds` is where the decider acts from
 * (decidingLocationIds); it defaults to the studio the leave was filed at,
 * which is right whenever that is where the caller was authorised.
 *
 * FAILS SOFT, and only ever narrower: unreadable siblings leave the deciding
 * studios themselves (logged), never an open read and never an error that
 * would cost the approver the clashes at their own studio.
 */
export async function findLeaveClashes(db, request, todayIso, { scopeLocationIds } = {}) {
  const win = clashWindow(request, todayIso)
  if (!win) return { clashes: [], error: null }

  // An explicit empty scope means "this decider acts from nowhere": nothing is
  // read. Only an OMITTED scope defaults to the filed-at studio.
  const anchors = [...new Set((scopeLocationIds === undefined ? [request.location_id] : scopeLocationIds || []).filter(Boolean))]
  if (anchors.length === 0) {
    logWarn('time-off', 'no studio to scope the leave clash check from; no clashes read', { requestId: request.id })
    return { clashes: [], error: null }
  }
  const scope = new Set(anchors)
  for (const anchor of anchors) {
    const { ids, error: sibErr } = await siblingLocationIds(db, anchor)
    if (sibErr) {
      logWarn('time-off', 'sibling studios unreadable; leave clash check is the deciding studio only', { requestId: request.id, locationId: anchor, err: sibErr.message })
      continue
    }
    for (const id of ids) scope.add(id)
  }

  const { rows, error } = await readAssignmentsInRange(
    db, [request.profile_id], win.lo, win.hi,
    'id, profile_id, block_id, status, shift_blocks!inner(id, block_date, start_time, end_time, location_id, rosters:roster_id(status), shift_templates(name), locations(name))',
    [...scope],
  )
  if (error) return { clashes: [], error }
  const clashes = rows
    .filter(isLiveAssignment)
    .map(flattenAssignment)
    // The query filter is the boundary; re-checked here at no cost.
    .filter((c) => scope.has(c.location_id))
    .filter((c) => c.block_date >= win.lo && c.block_date <= win.hi)
    .sort((a, b) => (a.block_date + (a.start_time || '')).localeCompare(b.block_date + (b.start_time || '')))
  return { clashes, error: null }
}

// ── Own-shift preview (LEAVEPHONE.1) ──────────────────────────────────────
//
// What a COACH is shown before filing leave: their own shifts inside the
// range. Not findLeaveClashes — that is the approver's read (drafts included,
// block times). Two rules differ here, both load-bearing:
//   • PUBLISHED ONLY. A coach never sees an unpublished shift; "published" is
//     derived from the block's roster exactly as roster-read.js toApiShiftRow
//     does. A block with no roster is not published.
//   • EFFECTIVE times: assignment override → block → template, the calendar's
//     resolution (shared/roster-month.js).
// The row is an allow-list: id, date, times, template name, studio name.
const OWN_SHIFT_PREVIEW_SELECT =
  'id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, block_date, start_time, end_time, location_id, rosters:roster_id(status), shift_templates(name, start_time, end_time), locations(name))'

/** Pure. One embedded shift_assignments row → the preview row. */
export function ownShiftPreviewRow(a) {
  const b = a?.shift_blocks || {}
  const tpl = b.shift_templates || {}
  const shape = {
    start_time_override: a?.start_time_override || null,
    end_time_override: a?.end_time_override || null,
    block_start_time: b.start_time || null,
    block_end_time: b.end_time || null,
    shift_templates: tpl,
  }
  return {
    id: a?.id,
    block_date: b.block_date,
    start_time: effectiveShiftStart(shape),
    end_time: effectiveShiftEnd(shape),
    template_name: tpl.name || null,
    location_name: b.locations?.name || null,
  }
}

/**
 * The profile's own PUBLISHED, live shifts inside [startIso, endIso], from
 * today on, at any studio. `profileId` must be the authenticated caller — the
 * route never takes it from the request.
 */
export async function findOwnPublishedShifts(db, profileId, startIso, endIso, todayIso) {
  const win = clashWindow({ start_date: startIso, end_date: endIso }, todayIso)
  if (!profileId || !win) return { shifts: [], error: null }
  const { rows, error } = await readAssignmentsInRange(db, [profileId], win.lo, win.hi, OWN_SHIFT_PREVIEW_SELECT)
  if (error) return { shifts: [], error }
  const shifts = rows
    .filter(isLiveAssignment)
    .filter((a) => a.profile_id === profileId)
    .filter((a) => a.shift_blocks?.rosters?.status === 'published')
    .map(ownShiftPreviewRow)
    .filter((s) => s.block_date >= win.lo && s.block_date <= win.hi)
    .sort((x, y) => (x.block_date + (x.start_time || '')).localeCompare(y.block_date + (y.start_time || '')))
  return { shifts, error: null }
}

/**
 * Pure. request id → number of live shifts it clashes with. Only pending
 * (unexpired) and approved requests can clash; everything else is 0/absent.
 *
 * ORGSCOPE.2 — `scopeByRequestId` (Map: request id → Set of location ids), when
 * given, is the studios each request may count shifts AT; a request it does
 * not list counts 0. Omitted = every shift passed in counts (the caller has
 * already decided they all may).
 */
export function bucketClashCounts(requests, assignments, todayIso, scopeByRequestId = null) {
  const byProfile = new Map()
  for (const a of assignments || []) {
    if (!isLiveAssignment(a)) continue
    const date = a.shift_blocks?.block_date || a.block_date
    if (!date) continue
    if (!byProfile.has(a.profile_id)) byProfile.set(a.profile_id, [])
    byProfile.get(a.profile_id).push({ date, locationId: a.shift_blocks?.location_id || a.location_id || null })
  }
  const counts = {}
  for (const r of requests || []) {
    if (r.status !== 'pending' && r.status !== 'approved') continue
    const win = clashWindow(r, todayIso)
    if (!win) continue
    const scope = scopeByRequestId ? scopeByRequestId.get(r.id) || new Set() : null
    counts[r.id] = (byProfile.get(r.profile_id) || [])
      .filter((x) => x.date >= win.lo && x.date <= win.hi && (!scope || scope.has(x.locationId)))
      .length
  }
  return counts
}

const COUNT_SELECT = 'id, profile_id, status, shift_blocks!inner(block_date, location_id)'

function spanOf(requests, todayIso) {
  const windows = requests.map((r) => clashWindow(r, todayIso))
  return { lo: windows.map((w) => w.lo).sort()[0], hi: windows.map((w) => w.hi).sort().at(-1) }
}

/**
 * request id → how many live shifts it clashes with, for a whole list.
 *
 * ORGSCOPE.2 — this count is the badge on the Time Off list and the warning in
 * the approvals queue; findLeaveClashes is the list the approver then gets. It
 * read every shift of the person at every studio, so for a coach on staff in
 * two organisations it told one tenant how busy the other's roster is, and
 * disagreed with the (ORGSCOPE.1-bounded) list it sits above. Now each
 * request counts exactly what findLeaveClashes would show THIS caller for it:
 * shifts at the studios they decide it from (decidingLocationIds — master:
 * every studio the person or the request belongs to) and those studios'
 * organisations. One whole-call scope would be simpler and still wrong: a
 * caller who approves in two organisations would count organisation B's
 * shifts into a request they can only decide from organisation A.
 *
 * The caller's OWN requests count their own shifts anywhere: those are theirs
 * to see, and nobody decides their own leave, so there is no list to disagree
 * with. They are read separately so they never widen a colleague's read.
 *
 * Still ONE batched shift read for everyone else's requests, restricted to the
 * union of the per-request scopes and re-checked per request in code.
 *
 * FAILS SOFT, only ever narrower: unreadable memberships leave each request
 * its filed-at studio, unreadable siblings leave the deciding studio alone
 * (both logged). A failed SHIFT read is still returned as `error` with no
 * counts; both callers already degrade that to "no badge", never to a hidden
 * list or queue.
 */
export async function countLeaveClashes(db, requests, todayIso, { user } = {}) {
  const open = (requests || []).filter((r) => (r.status === 'pending' || r.status === 'approved') && clashWindow(r, todayIso))
  if (open.length === 0) return { counts: {}, error: null }

  const own = user?.id ? open.filter((r) => r.profile_id === user.id) : []
  const others = open.filter((r) => !own.includes(r))
  let counts = {}

  if (own.length > 0) {
    const { lo, hi } = spanOf(own, todayIso)
    const { rows, error } = await readAssignmentsInRange(db, [user.id], lo, hi, COUNT_SELECT)
    if (error) return { counts: {}, error }
    counts = bucketClashCounts(own, rows, todayIso)
  }
  if (others.length === 0) return { counts, error: null }

  // Where the caller decides each request from.
  const { byProfile, error: memberErr } = await getLocationIdsByProfile(db, others.map((r) => r.profile_id))
  if (memberErr) {
    logWarn('time-off', 'memberships unreadable; leave clash counts use the filed-at studio only', { err: memberErr.message })
  }
  const anchorsByRequest = new Map(others.map((r) => [r.id, decidingLocationIds(user, r.location_id, byProfile.get(r.profile_id) || [])]))

  // Each deciding studio → itself plus its organisation's other studios.
  const anchors = [...new Set([...anchorsByRequest.values()].flat())]
  const orgScope = new Map(await Promise.all(anchors.map(async (anchor) => {
    const { ids, error: sibErr } = await siblingLocationIds(db, anchor)
    if (sibErr) {
      logWarn('time-off', 'sibling studios unreadable; leave clash count is the deciding studio only', { locationId: anchor, err: sibErr.message })
    }
    return [anchor, [anchor, ...ids]]
  })))
  const scopeByRequestId = new Map(others.map((r) => [r.id, new Set(anchorsByRequest.get(r.id).flatMap((a) => orgScope.get(a)))]))

  const countable = others.filter((r) => scopeByRequestId.get(r.id).size > 0)
  let rows = []
  if (countable.length > 0) {
    const { lo, hi } = spanOf(countable, todayIso)
    const union = [...new Set(countable.flatMap((r) => [...scopeByRequestId.get(r.id)]))]
    const read = await readAssignmentsInRange(db, [...new Set(countable.map((r) => r.profile_id))], lo, hi, COUNT_SELECT, union)
    if (read.error) return { counts: {}, error: read.error }
    rows = read.rows
  }
  return { counts: { ...counts, ...bucketClashCounts(others, rows, todayIso, scopeByRequestId) }, error: null }
}
