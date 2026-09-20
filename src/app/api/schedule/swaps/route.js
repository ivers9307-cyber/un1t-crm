import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { notifyOpenPool } from '@/lib/swap-cover-server'
import { swapShiftShape } from '@/lib/roster-read'
import { isLiveAssignment } from '@/lib/roster'
import { dublinTodayStr } from '@/lib/dublin-time'

const SwapCreateSchema = z.object({
  requester_shift_id: uuidLike,
  target_shift_id: uuidLike.nullable().optional(),
  target_id: uuidLike.nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
})

// RETIRE-SHIFTS-MIRROR.5c — swap rows now FK shift_assignments(id), not the
// legacy shifts(id). The embedded assignment (+ its block + template) is
// flattened back to the legacy shift shape via swapShiftShape() so the GET
// response stays byte-identical for every consumer (web approvals,
// SwapRequestsManager, web + mobile dashboards).
const SWAP_SHIFT_EMBED = `
  id, profile_id, status, notes, start_time_override, end_time_override,
  shift_blocks!block_id (
    block_date, start_time, end_time,
    shift_templates ( name, start_time, end_time, role_label )
  ),
  profiles!profile_id ( id, full_name )
`

// GET /api/schedule/swaps?location_id=xxx&status=pending
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const status = searchParams.get('status')
  const forMe = searchParams.get('for_me') === '1'
  const open = searchParams.get('open') === '1'
  const db = createServerClient()

  let query = db.from('shift_swap_requests')
    .select(`
      *,
      requester_shift:shift_assignments!requester_shift_id(${SWAP_SHIFT_EMBED}),
      target_shift:shift_assignments!target_shift_id(${SWAP_SHIFT_EMBED}),
      requester:profiles!requester_id(id, full_name, avatar_url),
      target:profiles!target_id(id, full_name, avatar_url),
      reviewer:profiles!reviewed_by(id, full_name)
    `)
    .order('created_at', { ascending: false })

  const scopeIds = locationId ? [locationId] : getUserLocationIds(user)
  if (scopeIds.length === 0) return NextResponse.json({ success: true, data: [] })
  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    query = query.in('location_id', scopeIds)
  }
  if (status) query = query.eq('status', status)

  // COACHSCOPE.1 — this list used to return EVERY swap at the studio to any
  // coach there (who is swapping with whom, their reasons, the manager's
  // review notes). A caller now sees a location's whole list only if they
  // review swaps THERE: a manager role at that location, or the
  // approvals_shift_swaps permission for it (the same gate PUT /swaps/[id]
  // approves with). Everyone else gets exactly what the coach swap UIs read:
  // swaps they requested, swaps targeted at / claimed by them, and the open
  // pool (untargeted + pending) they may claim.
  const reviewerLocIds = new Set(scopeIds.filter((loc) => canReviewSwapsAt(user, loc)))
  if (reviewerLocIds.size < scopeIds.length) {
    const terms = [
      `requester_id.eq.${user.id}`,
      `target_id.eq.${user.id}`,
      'and(target_id.is.null,status.eq.pending)',
    ]
    if (reviewerLocIds.size > 0) terms.unshift(`location_id.in.(${[...reviewerLocIds].join(',')})`)
    query = query.or(terms.join(','))
  }

  // CT-P3 actionable lists for coaches. for_me = swaps targeted at / claimed
  // by the caller (needs their accept/decline or shows "awaiting manager").
  // open = unclaimed pool the caller may take (not their own). Names ride
  // along via the service-role profiles embed (works for web + mobile, which
  // can't embed profiles from its authenticated client).
  if (forMe || open) {
    if (!user) return NextResponse.json({ success: true, data: [] })
    if (forMe) {
      query = query.eq('target_id', user.id).in('status', ['pending', 'awaiting_approval'])
    } else if (open) {
      query = query.is('target_id', null).eq('status', 'pending').neq('requester_id', user.id)
    }
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Flatten the embedded assignment back to the legacy shift shape the
  // consumers read (requester_shift.shift_date / .shift_templates / overrides).
  const shaped = (data || []).flatMap((row) => {
    const full = {
      ...row,
      requester_shift: swapShiftShape(row.requester_shift),
      target_shift: swapShiftShape(row.target_shift),
    }
    if (reviewerLocIds.has(row.location_id)) return [full]
    // The query's .or() already narrowed these; this is the same rule again
    // in code, so the response never depends on the filter string alone.
    const mine = row.requester_id === user.id || row.target_id === user.id
    const openPool = row.target_id == null && row.status === 'pending'
    if (!mine && !openPool) return []
    return [slimSwapForCoach(full, user.id, mine)]
  })
  return NextResponse.json({ success: true, data: shaped })
}

function canReviewSwapsAt(user, locationId) {
  return hasRoleAtLocation(user, locationId, MANAGER_ROLES)
    || hasPermissionForLocation(user, locationId, APPROVAL_CATEGORY_PERMISSION.shift_swaps)
}

// COACHSCOPE.1 — a coach's view of a swap row. A colleague's shift embed loses
// its assignment notes (a manager's working notes about that person); a row
// the caller is not party to (an open-pool swap they may claim) also loses the
// requester's free-text reason and any review note. Names, shift name, date
// and times — what the swap UIs render — stay.
function slimSwapForCoach(row, viewerId, mine) {
  const slimShift = (sh) => (sh && sh.profile_id !== viewerId ? { ...sh, notes: null } : sh)
  return {
    ...row,
    reason: mine ? row.reason : null,
    review_note: mine ? row.review_note : null,
    requester_shift: slimShift(row.requester_shift),
    target_shift: slimShift(row.target_shift),
  }
}

// POST /api/schedule/swaps — Create a swap request
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // ROSTER-FIX.2 — a swap with yourself is not a swap: on approval the two
  // sides resolve to the same person, so the request can only ever sit in
  // someone's inbox as noise. Reject it before any read.
  if (body.target_id && body.target_id === user.id) {
    return NextResponse.json({ success: false, error: 'You cannot target yourself' }, { status: 400 })
  }

  const db = createServerClient()

  // Verify the requester owns this assignment (requester_shift_id is now a
  // shift_assignments.id — RETIRE-SHIFTS-MIRROR.5c). Pull location_id off
  // the assignment's block.
  const { data: assignment } = await db.from('shift_assignments')
    .select('id, profile_id, status, shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status))')
    .eq('id', body.requester_shift_id)
    .eq('profile_id', user.id)
    .single()

  if (!assignment) {
    return NextResponse.json({ success: false, error: 'Shift not found or not yours' }, { status: 404 })
  }
  const swapLocationId = assignment.shift_blocks?.location_id
  if (!swapLocationId) {
    return NextResponse.json({ success: false, error: 'Shift has no location' }, { status: 400 })
  }

  // ROSTER-FIX.2 — the requester's shift must be live, published (D1: a
  // coach never acts on a draft) and in the future.
  if (!isLiveAssignment(assignment)) {
    return NextResponse.json({ success: false, error: 'That shift is no longer active' }, { status: 400 })
  }
  if (assignment.shift_blocks?.rosters?.status !== 'published') {
    return NextResponse.json({ success: false, error: 'That shift is not published yet' }, { status: 400 })
  }
  if ((assignment.shift_blocks?.block_date || '') < dublinTodayStr()) {
    return NextResponse.json({ success: false, error: 'You can only swap a future shift' }, { status: 400 })
  }

  // ROSTER-FIX.2 — a reciprocal swap must name BOTH the target coach and one
  // of their own live shifts at this location. Previously target_shift_id
  // was inserted unchecked, so any assignment in the database could be
  // named and, on approval, reassigned to the requester.
  if (body.target_shift_id && !body.target_id) {
    return NextResponse.json({ success: false, error: 'target_id is required with target_shift_id' }, { status: 400 })
  }
  if (body.target_shift_id) {
    const { data: targetShift } = await db.from('shift_assignments')
      .select('id, profile_id, status, shift_blocks!block_id(location_id, block_date, rosters:roster_id(status))')
      .eq('id', body.target_shift_id)
      .eq('profile_id', body.target_id)
      .maybeSingle()
    if (!targetShift || !isLiveAssignment(targetShift)) {
      return NextResponse.json({ success: false, error: 'Target shift not found or not theirs' }, { status: 400 })
    }
    // ROSTER-FIX.2 — the D1 draft gate has to cover the TARGET side too. The
    // requester's own shift was checked for a published roster but the
    // target's was not, so a coach could name a teammate's draft-roster
    // shift and surface a roster nobody has published yet.
    if (targetShift.shift_blocks?.rosters?.status !== 'published') {
      return NextResponse.json({ success: false, error: 'Target shift is not published yet' }, { status: 400 })
    }
    if (targetShift.shift_blocks?.location_id !== swapLocationId) {
      return NextResponse.json({ success: false, error: 'Target shift is at a different location' }, { status: 400 })
    }
    if ((targetShift.shift_blocks?.block_date || '') < dublinTodayStr()) {
      return NextResponse.json({ success: false, error: 'Target shift is in the past' }, { status: 400 })
    }
  }

  // ROSTER-FIX.2 — one open swap per shift (mig 599 also enforces this).
  // ROSTER-FIX.2 — this is our own read, not a client mistake: an unreadable
  // guard must not fall through to the insert as "no open swap".
  const { data: openSwaps, error: openSwapsError } = await db.from('shift_swap_requests')
    .select('id')
    .eq('requester_shift_id', body.requester_shift_id)
    .in('status', ['pending', 'awaiting_approval'])
  if (openSwapsError) {
    return NextResponse.json({ success: false, error: openSwapsError.message }, { status: 500 })
  }
  if ((openSwaps || []).length > 0) {
    return NextResponse.json({ success: false, error: 'This shift already has an open swap request' }, { status: 409 })
  }

  const { data, error } = await db.from('shift_swap_requests').insert({
    location_id: swapLocationId,
    requester_shift_id: body.requester_shift_id,
    requester_id: user.id,
    target_shift_id: body.target_shift_id || null,
    target_id: body.target_id || null,
    reason: body.reason || null,
    status: 'pending',
  }).select().single()

  // ROSTER-FIX.2 — mig 599's partial unique index is the race-proof half of
  // the open-swap check above; surface it as the same 409, not a raw 400.
  if (error?.code === '23505') {
    return NextResponse.json({ success: false, error: 'This shift already has an open swap request' }, { status: 409 })
  }
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Notify the targeted teammate if one was specified, otherwise alert
  // managers at the location that an open swap is up for grabs, and every
  // coach at the studio who could take it (src/lib/swap-cover-server.js).
  // Either way delivery is best-effort.
  //
  // ROSTER-FIX.8d — notifyUsers*, not sendPush*: a swap is a request someone
  // has to answer, and a push-only notification reaches nobody who has not
  // installed the app. `swap` is now fallbackEmail in the registry, so a
  // recipient with no device tokens gets the email instead (the shape
  // time-off has used since NOTIF.8).
  //
  // ROSTER-FIX.8f — full_name is nullable on profiles, so a coach who has never
  // filled theirs in interpolated as the literal "null wants to swap a shift
  // with you" into a push, a lock screen and an email subject line. Same
  // fallback the decision notifications use ([id]/route.js).
  const actor = user.full_name || 'A coach'
  if (body.target_id) {
    notifyUsersOnce(db, `swap_inbound:${data.id}`, [body.target_id], {
      title: 'New shift swap request',
      body: `${actor} wants to swap a shift with you. Tap to review.`,
      category: 'swap',
      emailSubject: `${actor} wants to swap a shift with you`,
      data: { type: 'swap_inbound', swap_id: data.id },
    }).catch(err => console.error('[swaps] notify target failed', err))
  } else {
    notifyUsersAtRolesOnce(db, `swap_open:${data.id}`, swapLocationId, MANAGER_ROLES, {
      title: 'Open swap request',
      body: `${actor} posted a shift for swap. Tap to review.`,
      category: 'swap',
      emailSubject: 'An open shift swap needs a decision',
      data: { type: 'swap_open', swap_id: data.id },
    }).catch(err => console.error('[swaps] notify managers failed', err))

    // COVERLOOP.1 — every coach at the studio who could take it, not only the
    // ones already working that day. Inside after(): the fan-out awaits several
    // reads before it sends, and an un-awaited promise left hanging past the
    // response is the shape Vercel can freeze mid-flight (SWAPNOTIFY.1).
    after(() => notifyOpenPool(db, {
      swapId: data.id,
      locationId: swapLocationId,
      block: assignment.shift_blocks,
      requester: { id: user.id, full_name: user.full_name },
    }).catch(err => console.error('[swaps] notify open pool failed', err)))
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
