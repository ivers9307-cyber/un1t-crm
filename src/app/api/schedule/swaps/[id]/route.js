// src/app/api/schedule/swaps/[id]/route.js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { swapStatusSchema } from '@/lib/schemas'
import { resolveSwapTransition } from '@/lib/swap-lifecycle'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'

const SwapReviewSchema = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/swaps/:id — drive a swap through its lifecycle.
// Coaches: claim / accept / decline / withdraw / cancel-own.
// Managers: approve / reject (finalises on shift_assignments).
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapReviewSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Fetch the swap. requester_shift_id / target_shift_id are shift_assignments.id.
  // Only profile_id is read off the embeds (for the reciprocal-swap reassign).
  const { data: swap } = await db.from('shift_swap_requests')
    .select('*, requester_shift:shift_assignments!requester_shift_id(id, profile_id, block_id), target_shift:shift_assignments!target_shift_id(id, profile_id, block_id)')
    .eq('id', params.id)
    .single()

  const decision = resolveSwapTransition({
    swap,
    requestedStatus: body.status,
    user,
    userLocationIds: getUserLocationIds(user),
    reviewNote: body.review_note ?? null,
  })

  if (!decision.ok) {
    return NextResponse.json({ success: false, error: decision.error }, { status: decision.status })
  }

  // Apply assignment effects first (reassign / reciprocal swap / drop), then
  // the swap row. Assignment writes are awaited so a failure surfaces.
  for (const op of decision.assignmentOps) {
    const { error: opErr } = await db.from('shift_assignments').update(op.set).eq('id', op.id)
    if (opErr) return NextResponse.json({ success: false, error: opErr.message }, { status: 400 })
  }

  const { data, error } = await db.from('shift_swap_requests')
    .update(decision.swapUpdates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Best-effort pushes — never block or fail the response.
  dispatchSwapPushes(decision, swap, user).catch(err => console.error('[swaps] push failed', err))

  return NextResponse.json({ success: true, data })
}

// Map the resolver's notify intents to Expo pushes. Bodies live here because
// they need user.full_name and human copy (the resolver stays pure).
async function dispatchSwapPushes(decision, swap, user) {
  const actor = user.full_name || 'A coach'
  for (const n of decision.notify) {
    switch (n.kind) {
      case 'claim_for_requester':
        await sendPush(n.to, { title: 'Shift claimed', body: `${actor} claimed your shift — awaiting manager approval.`, category: 'swap', data: { type: 'swap_claimed', swap_id: swap.id } })
        break
      case 'accept_for_requester':
        await sendPush(n.to, { title: 'Swap accepted', body: `${actor} accepted your swap — awaiting manager approval.`, category: 'swap', data: { type: 'swap_accepted', swap_id: swap.id } })
        break
      case 'claim_for_managers':
      case 'accept_for_managers':
        await sendPushToRolesAtLocation(swap.location_id, MANAGER_ROLES, { title: 'Swap awaiting approval', body: `${actor} took a shift. Tap to approve.`, category: 'swap', data: { type: 'swap_awaiting', swap_id: swap.id } })
        break
      case 'withdraw_for_requester':
        await sendPush(n.to, { title: 'Swap re-opened', body: `${actor} withdrew — your shift is open for swap again.`, category: 'swap', data: { type: 'swap_withdrawn', swap_id: swap.id } })
        break
      case 'decline_for_requester':
        await sendPush(n.to, { title: 'Swap declined', body: `${actor} declined your swap request.`, category: 'swap', data: { type: 'swap_declined', swap_id: swap.id } })
        break
      case 'decision_for_requester':
      case 'decision_for_taker': {
        const verb = decision.swapUpdates.status === 'approved' ? 'approved' : 'declined'
        await sendPush(n.to, { title: `Swap ${verb}`, body: `Your shift swap was ${verb}${decision.swapUpdates.review_note ? ` — “${decision.swapUpdates.review_note}”` : ''}.`, category: 'swap', data: { type: 'swap_decision', swap_id: swap.id, status: decision.swapUpdates.status } })
        break
      }
      default:
        break
    }
  }
}
