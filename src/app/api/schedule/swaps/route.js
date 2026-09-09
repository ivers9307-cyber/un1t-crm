import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { swapShiftShape } from '@/lib/roster-read'
import { isLiveAssignment } from '@/lib/roster'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

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

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }
  if (status) query = query.eq('status', status)

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
  const shaped = (data || []).map((row) => ({
    ...row,
    requester_shift: swapShiftShape(row.requester_shift),
    target_shift: swapShiftShape(row.target_shift),
  }))
  return NextResponse.json({ success: true, data: shaped })
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
    .select('id, profile_id, status, shift_blocks!block_id(location_id, block_date, rosters:roster_id(status))')
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
  // managers at the location that an open swap is up for grabs, and the
  // coaches who could actually take it. Either way delivery is best-effort.
  //
  // ROSTER-FIX.8d — notifyUsers*, not sendPush*: a swap is a request someone
  // has to answer, and a push-only notification reaches nobody who has not
  // installed the app. `swap` is now fallbackEmail in the registry, so a
  // recipient with no device tokens gets the email instead (the shape
  // time-off has used since NOTIF.8).
  if (body.target_id) {
    notifyUsersOnce(db, `swap_inbound:${data.id}`, [body.target_id], {
      title: 'New shift swap request',
      body: `${user.full_name} wants to swap a shift with you. Tap to review.`,
      category: 'swap',
      emailSubject: `${user.full_name} wants to swap a shift with you`,
      data: { type: 'swap_inbound', swap_id: data.id },
    }).catch(err => console.error('[swaps] notify target failed', err))
  } else {
    notifyUsersAtRolesOnce(db, `swap_open:${data.id}`, swapLocationId, MANAGER_ROLES, {
      title: 'Open swap request',
      body: `${user.full_name} posted a shift for swap. Tap to review.`,
      category: 'swap',
      emailSubject: 'An open shift swap needs a decision',
      data: { type: 'swap_open', swap_id: data.id },
    }).catch(err => console.error('[swaps] notify managers failed', err))

    notifyOpenPool(db, data.id, swapLocationId, assignment.shift_blocks?.block_date, user)
      .catch(err => console.error('[swaps] notify open pool failed', err))
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}

// ROSTER-FIX.8d — an open swap used to be visible only to managers, so the
// coaches who could actually claim it found out by opening the app and
// looking. Notify the people already working that day at that location: they
// are on site, so picking up a neighbouring shift is a real option for them.
//
// Fail-soft by construction. This runs after the swap row is committed and
// the response has been decided, so an unreadable pool must never turn a
// created swap into an error, and never costs the manager notification either
// (it is a separate call). One query, no fan-out.
async function notifyOpenPool(db, swapId, locationId, blockDate, user) {
  if (!locationId || !blockDate) return

  const { data: rows, error } = await db.from('shift_assignments')
    .select('profile_id, status, shift_blocks!inner(location_id, block_date)')
    .eq('shift_blocks.location_id', locationId)
    .eq('shift_blocks.block_date', blockDate)
  if (error) {
    logWarn('swaps', 'open-pool recipient query failed; managers were still notified', {
      swapId, err: error.message,
    })
    return
  }

  const ids = [...new Set(
    (rows || [])
      .filter(r => r.profile_id && r.profile_id !== user.id && isLiveAssignment(r))
      .map(r => r.profile_id),
  )]
  if (!ids.length) return

  await notifyUsersOnce(db, `swap_open_pool:${swapId}`, ids, {
    title: 'A shift is up for swap',
    body: `${user.full_name} posted a shift for swap on a day you are working. Tap to take it.`,
    category: 'swap',
    emailSubject: 'A shift is up for swap',
    data: { type: 'swap_open_pool', swap_id: swapId, block_date: blockDate },
  })
}
