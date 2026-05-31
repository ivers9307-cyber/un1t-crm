import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

// PATCH /api/agent/membership-requests/[id] — manager decides a queued
// pause/cancellation. 'approved' + 'declined' apply to both kinds;
// 'saved' is the retention outcome on a cancellation (member kept).
// The actual Glofox change is made by staff manually after approving.

const DecisionSchema = z.object({
  status: z.enum(['approved', 'declined', 'saved', 'actioned']),
  decision_note: z.string().max(2000).nullable().optional(),
})

export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()

  // Confirm the request belongs to a location this manager can act on.
  const { data: row } = await db.from('agent_membership_requests')
    .select('id, location_id').eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // null = master
  if (allowed !== null && !allowed.includes(row.location_id)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const v = await validateBody(request, DecisionSchema)
  if (!v.ok) return v.response

  const { data, error } = await db.from('agent_membership_requests').update({
    status: v.data.status,
    decision_note: v.data.decision_note?.trim() || null,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select('id, status, decided_at, decision_note').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, request: data })
}
