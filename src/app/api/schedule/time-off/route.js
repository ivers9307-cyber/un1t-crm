import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { timeOffTypeSchema, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { dublinTodayStr } from '@/lib/dublin-time'
import {
  getLocationMemberIds, getProfileLocationIds, leaveScopeOrFilter, canDecideTimeOff,
  resolveTimeOffApproverIds, getEmploymentType, getHolidayAllowance, ensureHolidayAllowanceRow,
  countLeaveClashes, findLeaveClashes, chargeableLeaveSegments, findOwnPublishedShifts, isRealIsoDate,
  getLocationIdsByProfile, getOrgAdminLocationIdsByProfile,
  getPendingHolidayDays,
} from '@/lib/time-off-leave'
import {
  annotateCancelAsk, isMissingCancelSchemaError, CANCEL_ASK_OFF, annotateApprovedLeaveGuard, requesterLeaveTier,
} from '@/lib/time-off-cancel'
import { logError } from '@/lib/log'
import {
  isTimeOffTypeAllowedFor, RESTRICTED_TYPE_ERROR, isExpiredPendingRequest, effectiveTimeOffStatus,
} from '@shared/time-off'

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const TimeOffRequestSchema = z.object({
  // Use the shared catalogue (holiday/sick/unpaid/other/unavailable) — the
  // employment-gated UI decides which of these a given user is offered, but the
  // API must accept every valid type. A hard-coded enum here drifted from the
  // shared schema + the DB CHECK (mig 283) and rejected contractors' 'unavailable'.
  type: timeOffTypeSchema,
  start_date: ISO_DATE,
  end_date: ISO_DATE,
  reason: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.optional(),
  // LEAVE.2 — an approver recording leave for someone else (a coach who
  // phoned in sick). Omitted = the caller's own request.
  profile_id: uuidLike.optional(),
})

// GET /api/schedule/time-off?location_id=xxx&start_date=xxx&end_date=xxx&status=xxx&profile_id=xxx
// GET /api/schedule/time-off?preview=1&type=xxx&start_date=xxx&end_date=xxx[&location_id=xxx]   (LEAVEPHONE.1 — see previewOwnLeave)
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // LEAVEPHONE.1 — the leave form's preview. A different question from the
  // list below ("what will this cost me, and which of MY shifts does it hit?"),
  // answered for the caller only, so it returns before any of the list's
  // scoping runs. location_id has already cleared assertLocationAccess above.
  if (searchParams.get('preview') === '1') return previewOwnLeave(user, searchParams)

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const status = searchParams.get('status')
  const profileId = searchParams.get('profile_id')
  const db = createServerClient()

  // Every filter is recorded, then applied to whichever select is sent, so the
  // pre-624 retry below can never be a DIFFERENT (wider) read than the first.
  const filters = []

  // ROSTER-FIX.2 — anyone who is not a manager sees only their own requests.
  // SCHEDROLES.1 — "manager" is judged PER STUDIO (hasRoleAtLocation), never
  // from `user.role` (the ACTIVE studio's role).
  //
  // LEAVE.2 — leave covers the PERSON, not the studio it was filed at. So:
  //   • your own requests show wherever you look (a coach at both studios
  //     who filed from Hatch still sees it on Stillorgan's schedule);
  //   • a manager of a studio sees leave filed there AND leave taken by anyone
  //     who belongs there, wherever it was filed — otherwise Stillorgan never
  //     learns its coach is off because the request went in from Hatch.
  // Without a location_id the managed set is every studio the caller manages.
  const scopeIds = locationId ? [locationId] : getUserLocationIds(user)
  if (scopeIds.length === 0) return NextResponse.json({ success: true, data: [] })
  const managedIds = scopeIds.filter((id) => hasRoleAtLocation(user, id, MANAGER_ROLES))
  if (managedIds.length === 0) {
    filters.push((q) => q.eq('profile_id', user.id))
  } else {
    // Fail closed: an unreadable member list must not silently narrow a
    // manager's view to "filed here" (that is the bug this fixes).
    const { ids: memberIds, error: membersError } = await getLocationMemberIds(db, managedIds)
    if (membersError) {
      return NextResponse.json({ success: false, error: membersError.message }, { status: 500 })
    }
    const scope = `${leaveScopeOrFilter(managedIds, memberIds)},profile_id.eq.${user.id}`
    filters.push((q) => q.or(scope))
    if (profileId) filters.push((q) => q.eq('profile_id', profileId))
  }

  // LEAVE.2 — a pending request whose last day has passed is EXPIRED
  // (derived, not stored — see isExpiredPendingRequest). `pending` therefore
  // means "still decidable" and drops them; `expired` asks for exactly them.
  const today = dublinTodayStr()
  if (status === 'expired') {
    filters.push((q) => q.eq('status', 'pending').lt('end_date', today))
  } else if (status === 'pending') {
    filters.push((q) => q.eq('status', 'pending').gte('end_date', today))
  } else if (status) {
    filters.push((q) => q.eq('status', status))
  }

  // Date range filter — show requests that overlap with the given range
  if (startDate) filters.push((q) => q.lte('start_date', endDate || startDate))
  if (endDate) filters.push((q) => q.gte('end_date', startDate || endDate))

  // LEAVECANCEL.1 — `cancel_decider` is an embed through mig 624's
  // cancel_decided_by FK; the second read is the list as it was before that
  // migration, used ONLY when it is missing (below). Both selects are written
  // inline on purpose: check:select-columns only reads a literal .select() on
  // a .from() chain, and a shared constant hid them from it (probed).
  const listQuery = (withCancelDecider) => filters.reduce(
    (q, apply) => apply(q),
    withCancelDecider
      ? db.from('time_off_requests')
        .select(`
          *,
          profiles!profile_id(id, full_name, avatar_url, role),
          reviewer:profiles!reviewed_by(id, full_name),
          cancel_decider:profiles!cancel_decided_by(id, full_name)
        `)
        .order('start_date', { ascending: true })
      : db.from('time_off_requests')
        .select(`
          *,
          profiles!profile_id(id, full_name, avatar_url, role),
          reviewer:profiles!reviewed_by(id, full_name)
        `)
        .order('start_date', { ascending: true }),
  )

  let { data, error } = await listQuery(true)
  // LEAVECANCEL.1 — code reaches prod before its migration whenever a Vercel
  // preview of this branch runs, or on an ordering slip. Without mig 624,
  // PostgREST refuses the cancel_decider hint (PGRST200) and this GET used to
  // answer 400 to EVERY reader of leave (the Time Off page, the roster's
  // approved-leave read, the phone's My leave, Schedule and Studio tabs). That
  // one error class, and only that one, retries ONCE with the pre-624 read and
  // turns the new feature off for the answer; it is logged at error level
  // because it is still a slip. Any other error is the 400 it always was.
  const cancelSchemaMissing = !!error && isMissingCancelSchemaError(error)
  if (cancelSchemaMissing) {
    logError('time-off', 'mig 624 (time_off_requests cancel_* columns) is not applied; the leave list is served without cancellation requests', { err: error })
    ;({ data, error } = await listQuery(false))
  }
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  let rows = (data || []).map((r) => ({
    ...r,
    effective_status: effectiveTimeOffStatus(r, today),
    expired: isExpiredPendingRequest(r, today),
  }))

  // LEAVECANCEL.1 — a request to cancel APPROVED leave is columns on the row
  // (mig 624), and the leave stays `approved` while it waits. Each row says
  // where its ask stands and what THIS caller may do about it, judged by the
  // same functions the routes re-judge with, so the screen never offers a
  // button the server will refuse. Deciding depends on the requester's
  // studios, read only for colleagues' rows that carry an undecided ask (a
  // handful at most). Unreadable memberships only ever NARROW: the row keeps
  // its filed-at studio, and an owner there still sees their button.
  // Without mig 624 there is no ask to show and none to make: every row gets
  // CANCEL_ASK_OFF, so no screen offers a button whose write would fail.
  //
  // LEAVEGUARD.1 — and `approved_locked_to_owner`: a colleague's APPROVED
  // leave that only an owner (a master's: only another master) may take out
  // of force, judged by the PUT's own functions (requesterLeaveTier +
  // approvedLeaveGuardAllows). The tier needs the requester's profiles.role
  // (already on the row, the profiles!profile_id embed), their per-studio
  // ROLES (the one membership read, now also covering colleagues with
  // approved leave) and their org-admin grants (one more paged read). It is
  // independent of mig 624. Not paid when it cannot matter: a master caller
  // is never locked out, and a list with no colleague's approved leave has
  // nothing to lock. An unreadable read NARROWS: the tier is unknown (null),
  // judged as manager, so only an owner at a studio the request belongs to or
  // a master stays unlocked.
  const askedByOthers = cancelSchemaMissing ? [] : rows.filter((r) => r.cancel_requested_at && !r.cancel_decided_at && r.profile_id !== user.id)
  const callerIsMaster = user.profileRole === 'master'
  const approvedOfOthers = callerIsMaster ? [] : rows.filter((r) => r.status === 'approved' && r.profile_id !== user.id)
  let studiosByProfile = new Map()
  let rolesByProfile = null
  if (askedByOthers.length > 0 || approvedOfOthers.length > 0) {
    const { byProfile, membershipsByProfile, error: memberError } = await getLocationIdsByProfile(db, [...askedByOthers, ...approvedOfOthers].map((r) => r.profile_id))
    if (memberError) {
      logError('time-off', 'memberships unreadable; cancel-request buttons use the filed-at studio only, and colleagues\' approved leave is locked to owners', { err: memberError })
    } else {
      studiosByProfile = byProfile
      rolesByProfile = membershipsByProfile
    }
  }
  let orgAdminByProfile = new Map()
  if (approvedOfOthers.length > 0) {
    const { byProfile, error: orgError } = await getOrgAdminLocationIdsByProfile(db, approvedOfOthers.map((r) => r.profile_id))
    if (orgError) {
      logError('time-off', 'org-admin grants unreadable; colleagues\' approved leave is locked to owners', { err: orgError })
      orgAdminByProfile = null
    } else {
      orgAdminByProfile = byProfile
    }
  }
  const ownStudios = getUserLocationIds(user)
  const nowMs = Date.now()
  rows = rows.map((r) => {
    const isOwn = r.profile_id === user.id
    const studios = isOwn ? ownStudios : studiosByProfile.get(r.profile_id) || []
    const tier = isOwn || callerIsMaster || r.status !== 'approved' ? null : requesterLeaveTier({
      profileRole: r.profiles?.role ?? null,
      memberships: rolesByProfile ? rolesByProfile.get(r.profile_id) || [] : null,
      orgAdminLocationIds: orgAdminByProfile ? orgAdminByProfile.get(r.profile_id) || [] : null,
    }, r, studios)
    return {
      ...r,
      ...(cancelSchemaMissing ? CANCEL_ASK_OFF : annotateCancelAsk(r, user, today, studios, nowMs)),
      ...annotateApprovedLeaveGuard(r, user, studios, tier),
    }
  })

  // LEAVE.2 — `with_clashes=1` (the Time Off page) adds how many live shifts
  // each open request collides with. Advisory: a failed count degrades to no
  // count rather than hiding the requests.
  if (searchParams.get('with_clashes') === '1') {
    // ORGSCOPE.2 — counted per request from where THIS caller decides it, so
    // the badge is the number the approve list will show them.
    const { counts, error: clashError } = await countLeaveClashes(db, rows.filter((r) => !r.expired), today, { user })
    if (clashError) {
      console.error('[time-off] clash count failed', clashError.message)
    } else {
      rows = rows.map((r) => (r.id in counts ? { ...r, clash_count: counts[r.id] } : r))
    }
  }

  return NextResponse.json({ success: true, data: rows })
}

// POST /api/schedule/time-off — Create a time-off request
//
// LEAVE.2 — with `profile_id` (someone else) the caller is RECORDING leave on
// that person's behalf: they must be able to approve time off at the target
// studio, the person must belong to it, and the request is created already
// approved with `created_by` set (mig 616). Every other rule — overlap,
// contractor types, holiday balance — is judged for the PERSON, not the caller.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, TimeOffRequestSchema)
  if (!validation.ok) return validation.response
  const { type, start_date, end_date, reason, location_id, profile_id } = validation.data

  // If location_id is explicitly passed, it must be one the caller belongs to.
  // Otherwise fall through to user.activeLocation below.
  if (location_id) {
    const guard = assertLocationAccess(user, location_id)
    if (guard) return guard
  }

  const db = createServerClient()
  const subjectId = profile_id || user.id
  const onBehalf = subjectId !== user.id
  const targetLocation = location_id || user.activeLocation?.id

  // HOLIDAYLEAVE.1 — no body location_id and no active studio on the session.
  // The row cannot be inserted (location_id is NOT NULL) and a holiday could
  // not be counted, so say so before any read, rather than let the approver
  // check answer 403 or the balance check answer with a number worked out blind.
  if (!targetLocation) {
    return NextResponse.json({ success: false, error: 'No studio to file this request against' }, { status: 400 })
  }

  if (end_date < start_date) {
    return NextResponse.json({ success: false, error: 'End date must be on or after start date' }, { status: 400 })
  }

  // ROSTER-FIX.2 — splitAtYearEnd now peels one segment per calendar year,
  // so a typo'd end date (2226 for 2026) would fan out into two hundred
  // inserted rows. A year is already well past any real request.
  const spanDays = Math.round((Date.parse(`${end_date}T00:00:00Z`) - Date.parse(`${start_date}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > 366) {
    return NextResponse.json({ success: false, error: 'Time-off requests are limited to one year' }, { status: 400 })
  }

  // LEAVE.2 — recording for someone else: approver at the target studio, and
  // the person is on that studio's staff. A non-member is a 404 so the id is
  // not confirmed.
  if (onBehalf) {
    if (!canDecideTimeOff(user, targetLocation)) {
      return NextResponse.json({ success: false, error: 'Only someone who approves time off at this studio can record leave for a colleague' }, { status: 403 })
    }
    const { ids: subjectLocations, error: memberError } = await getProfileLocationIds(db, subjectId)
    if (memberError) {
      return NextResponse.json({ success: false, error: memberError.message }, { status: 500 })
    }
    if (!subjectLocations.includes(targetLocation)) {
      return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 })
    }
  }

  // LEAVE.3 — contractors may only mark themselves unavailable; the forms
  // hide the other types, this is the server's half. Fail closed: an
  // unreadable employment type must not let a holiday through.
  const { employmentType, error: employmentError } = await getEmploymentType(db, subjectId)
  if (employmentError) {
    return NextResponse.json({ success: false, error: employmentError.message }, { status: 500 })
  }
  if (!isTimeOffTypeAllowedFor(employmentType, type)) {
    return NextResponse.json({ success: false, error: RESTRICTED_TYPE_ERROR }, { status: 400 })
  }

  // ROSTER-FIX.2 — nothing stopped a coach filing the same week twice (or
  // ten times), which double-counted against the allowance and put two
  // rows on the manager's inbox for one absence. The error is checked
  // because this is our own read, not a client mistake: an unreadable clash
  // probe must never fall through to the insert as "no overlap".
  const { data: clashes, error: clashesError } = await db.from('time_off_requests')
    .select('id, start_date, end_date, status, type')
    .eq('profile_id', subjectId)
    .in('status', ['pending', 'approved'])
    .lte('start_date', end_date)
    .gte('end_date', start_date)

  if (clashesError) {
    return NextResponse.json({ success: false, error: clashesError.message }, { status: 500 })
  }
  if ((clashes || []).length > 0) {
    const c = clashes[0]
    const range = c.start_date === c.end_date ? c.start_date : `${c.start_date} – ${c.end_date}`
    const whose = onBehalf ? 'an existing request' : 'your existing request'
    return NextResponse.json({ success: false, error: `Overlaps ${whose} for ${range}` }, { status: 409 })
  }

  // HOLIDAYLEAVE.1 — a holiday is charged for working days only (Mon-Fri,
  // minus the studio country's bank holidays, minus the studio's closures),
  // at the studio it is filed at.
  // ROSTER-FIX.2 — a range that straddles 31 December becomes one row per
  // year, so each year's allowance is charged its own days.
  // LEAVEPHONE.1 — both live in chargeableLeaveSegments, which the leave
  // form's preview (GET ?preview=1) ALSO calls: the number a coach is shown
  // before filing is this number. Fails closed like the reads around it: an
  // unreadable holiday list is a 500, never "no bank holidays" (the
  // over-charge HOLIDAYLEAVE.1 fixed).
  const { segments, error: segmentsError } = await chargeableLeaveSegments(db, {
    type, locationId: targetLocation, startIso: start_date, endIso: end_date,
  })
  if (segmentsError) {
    return NextResponse.json({ success: false, error: segmentsError.message }, { status: 500 })
  }

  if (segments.reduce((sum, seg) => sum + seg.days, 0) < 1) {
    return NextResponse.json({ success: false, error: 'No working days in that range' }, { status: 400 })
  }

  // If it's a holiday, check remaining allowance — per segment year, since
  // each year has its own allowance row.
  // LEAVE.4 — this used to `continue` when no allowance row existed, and the
  // row only appears on the first APPROVED holiday, so nobody's first request
  // of a year was ever checked. With no row the balance is the person's
  // contract entitlement (getHolidayAllowance). Every read fails closed
  // (ROSTER-FIX.2): an unreadable balance is not an unlimited one.
  if (type === 'holiday') {
    for (const seg of segments) {
      if (seg.days < 1) continue
      const year = Number(seg.s.slice(0, 4))
      const { allowance, error: allowanceError } = await getHolidayAllowance(db, subjectId, year)
      if (allowanceError) {
        return NextResponse.json({ success: false, error: allowanceError.message }, { status: 500 })
      }
      const remaining = allowance.total_days + allowance.carried_over - allowance.used_days
      // LEAVEDAYS.1 — the same sum GET /api/schedule/allowances reports as
      // `pending_days`, so the form warns on the figure this refuses on.
      const { days: pendingDays, error: pendingError } = await getPendingHolidayDays(db, subjectId, year)
      if (pendingError) {
        return NextResponse.json({ success: false, error: pendingError.message }, { status: 500 })
      }
      if (seg.days > remaining - pendingDays) {
        const who = onBehalf ? 'They have' : 'You have'
        return NextResponse.json({
          success: false,
          error: `Insufficient holiday balance. ${who} ${remaining - pendingDays} days remaining (including pending requests).`
        }, { status: 400 })
      }
    }
  }

  // ROSTER-FIX.2 — ONE insert for every segment, not a round trip each: the
  // per-segment loop wrote the earlier years' rows and then returned a 400
  // on a later failure, so the caller's retry duplicated them.
  //
  // LEAVE.5 — an on-behalf request is inserted PENDING and approved by the
  // update below, never inserted as approved: the allowance trigger (mig 011)
  // is AFTER UPDATE only, so an approved INSERT would never charge the
  // holiday to the balance.
  const rows = segments.filter((seg) => seg.days >= 1).map((seg) => ({
    profile_id: subjectId,
    location_id: targetLocation,
    type,
    start_date: seg.s,
    end_date: seg.e,
    total_days: seg.days,
    reason: reason || null,
    status: 'pending',
    ...(onBehalf ? { created_by: user.id } : {}),
  }))

  const { data: inserted, error: insertError } = await db.from('time_off_requests').insert(rows).select(`
    *,
    profiles!profile_id(id, full_name, avatar_url, role)
  `)

  if (insertError) return NextResponse.json({ success: false, error: insertError.message }, { status: 400 })

  // `data` stays the first row so every existing client keeps working;
  // `data_all` carries the year-split siblings for anyone who wants them.
  const created = inserted || []
  if (!created[0]) {
    return NextResponse.json({ success: false, error: 'Time-off request was not created' }, { status: 500 })
  }

  if (onBehalf) {
    return approveRecordedLeave(db, user, created, { type, employmentType })
  }

  const data = created[0]

  // LEAVE.2 — tell everyone who can APPROVE it: the per-location time-off
  // approval permission, at the studio it was filed at and every other studio
  // the requester belongs to (leave covers the person). This used to be
  // owner + manager only, and head coaches — who make most approvals — never
  // heard. The requester is never told about their own request.
  const { ids: requesterLocations } = await getProfileLocationIds(db, user.id)
  const approverLocations = [...new Set([data.location_id, ...requesterLocations].filter(Boolean))]
  const range = data.start_date === data.end_date
    ? data.start_date
    : `${data.start_date} – ${data.end_date}`
  try {
    const { ids: approverIds, error: approverError } = await resolveTimeOffApproverIds(db, approverLocations)
    if (approverError) throw new Error(approverError.message)
    const recipients = approverIds.filter((id) => id !== user.id)
    if (recipients.length > 0) {
      // NOTIF.9 — push, email fallback for approvers without the app.
      notifyUsersOnce(db, `time_off_inbound:${data.id}`, recipients, {
        title: 'New time-off request',
        body: `${user.full_name} requested ${data.type} for ${range}.`,
        category: 'time_off',
        emailSubject: `Time-off request from ${user.full_name}`,
        data: { type: 'time_off_inbound', request_id: data.id },
      }).catch(err => console.error('[time-off] notify failed', err))
    }
  } catch (err) {
    // Best-effort — never block the API response on push delivery.
    console.error('[time-off] approver lookup failed', err?.message)
  }

  return NextResponse.json({ success: true, data, data_all: created }, { status: 201 })
}

// LEAVE.5 — the second half of recording leave for someone: approve what was
// just inserted, through the same update the approval route makes (so the
// allowance trigger charges a holiday), and hand back the shift clashes the
// same way an approval does.
//
// LEAVEGUARD.1 — deliberately NOT owner-gated when the person is a manager:
// recording leave (someone phoned in sick) puts leave INTO force, which is the
// ordinary approval permission's call. Only taking a manager's approved leave
// OUT of force needs an owner (PUT /api/schedule/time-off/[id]).
async function approveRecordedLeave(db, user, created, { type, employmentType }) {
  const ids = created.map((r) => r.id)
  if (type === 'holiday' && employmentType !== 'contractor') {
    for (const year of new Set(created.map((r) => Number(r.start_date.slice(0, 4))))) {
      const { error } = await ensureHolidayAllowanceRow(db, created[0].profile_id, year)
      if (error) {
        return NextResponse.json({
          success: false,
          error: `Recorded as pending, but the allowance could not be prepared: ${error.message}`,
          data: created[0],
        }, { status: 500 })
      }
    }
  }
  const now = new Date().toISOString()
  const { data: approved, error } = await db.from('time_off_requests')
    .update({ status: 'approved', reviewed_by: user.id, reviewed_at: now, updated_at: now })
    .in('id', ids)
    .select(`
      *,
      profiles!profile_id(id, full_name, avatar_url, role)
    `)
  if (error || !approved || approved.length !== ids.length) {
    // The rows exist as PENDING — visible and decidable — so say exactly that
    // rather than reporting a clean failure the caller would retry into a 409.
    return NextResponse.json({
      success: false,
      error: `Recorded as pending, but approving it failed${error ? `: ${error.message}` : ''}. Approve it from the list.`,
      data: created[0],
    }, { status: 500 })
  }

  const today = dublinTodayStr()
  const clashes = []
  for (const row of approved) {
    const { clashes: found, error: clashError } = await findLeaveClashes(db, row, today)
    if (clashError) console.error('[time-off] clash lookup failed', clashError.message)
    clashes.push(...(found || []))
  }

  const data = approved.find((r) => r.id === created[0].id) || approved[0]
  const range = data.start_date === data.end_date ? data.start_date : `${data.start_date} – ${data.end_date}`
  notifyUsersOnce(db, `time_off_recorded:${data.id}`, [data.profile_id], {
    title: 'Time off recorded',
    body: `${user.full_name} recorded ${data.type} for you for ${range}.`,
    category: 'time_off',
    emailSubject: 'Time off recorded for you',
    data: { type: 'time_off_decision', request_id: data.id, status: 'approved', start_date: data.start_date },
  }).catch(err => console.error('[time-off] notify failed', err))

  return NextResponse.json({ success: true, data, data_all: approved, clashes }, { status: 201 })
}

// LEAVEPHONE.1 — GET ?preview=1&type=&start_date=&end_date=[&location_id=]
//
// What the caller's leave form shows BEFORE they file:
//   • days    — what the POST would charge, from the SAME function it charges
//               with (chargeableLeaveSegments), for the studio the POST would
//               file at (location_id, else the active studio — the POST's own
//               targetLocation rule, including its "No studio" 400). The phone
//               does no day arithmetic: a holiday's cost depends on bank
//               holidays and studio closures it cannot see. A range the POST
//               would refuse as "No working days" is total 0 here, not an error.
//   • clashes — the caller's OWN published, live shifts in the range, from
//               today on, at any studio (leave covers the person).
// The profile is ALWAYS user.id: a profile_id in the query string is ignored,
// manager or not (recording leave for a colleague is a web flow with its own
// clash read on approval). Every read fails closed — a 500, never a guessed
// number. It does NOT judge the balance, the overlap or the employment gate:
// those stay the POST's, and the form says so by still submitting.
// `data` is an OBJECT on purpose: the list above returns an ARRAY, and the
// phone uses that difference to recognise a deployment that predates this
// branch and show nothing rather than something wrong.
async function previewOwnLeave(user, searchParams) {
  const type = timeOffTypeSchema.safeParse(searchParams.get('type'))
  if (!type.success) {
    return NextResponse.json({ success: false, error: 'type must be a valid time-off type' }, { status: 400 })
  }
  const start = searchParams.get('start_date') || ''
  const end = searchParams.get('end_date') || start
  // Real calendar dates, not only the pattern: 2026-02-30 fits YYYY-MM-DD and
  // V8 rolls it over to 2 March, which would answer 200 with a nonsense count.
  if (!isRealIsoDate(start) || !isRealIsoDate(end)) {
    return NextResponse.json({ success: false, error: 'start_date and end_date must be real dates, YYYY-MM-DD' }, { status: 400 })
  }
  if (end < start) {
    return NextResponse.json({ success: false, error: 'End date must be on or after start date' }, { status: 400 })
  }
  const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > 366) {
    return NextResponse.json({ success: false, error: 'Time-off requests are limited to one year' }, { status: 400 })
  }
  const locationId = searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No studio to file this request against' }, { status: 400 })
  }

  const db = createServerClient()
  const { segments, total, error: daysError } = await chargeableLeaveSegments(db, {
    type: type.data, locationId, startIso: start, endIso: end,
    // Asking is not requesting: the POST keeps the no-holiday-list warning,
    // a preview fired on every calendar tap does not repeat it.
    quiet: true,
  })
  if (daysError) return NextResponse.json({ success: false, error: daysError.message }, { status: 500 })

  const { shifts, error: shiftsError } = await findOwnPublishedShifts(db, user.id, start, end, dublinTodayStr())
  if (shiftsError) return NextResponse.json({ success: false, error: shiftsError.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    data: {
      type: type.data,
      start_date: start,
      end_date: end,
      days: {
        total,
        segments: segments.map((seg) => ({ year: Number(seg.s.slice(0, 4)), start_date: seg.s, end_date: seg.e, days: seg.days })),
      },
      clashes: shifts,
    },
  })
}
