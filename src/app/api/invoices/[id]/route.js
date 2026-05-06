// GET /api/invoices/[id] — full detail including computed scheduled
// hours + estimated cost for the contractor over the invoice period.
//
// Auth:
//   contractor (self) — can read their own invoice (no calc needed
//                       on their side, but we include it anyway so
//                       the resubmit form can show "you scheduled X
//                       hours" as a hint).
//   owner-at-loc / master — can read + see calc.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { computeScheduledForPeriod } from '@/lib/contractor-invoices'

export const runtime = 'nodejs'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()

  const { data: inv, error } = await db
    .from('contractor_invoices')
    .select(`
      *,
      contractor:contractor_id ( id, full_name, email, hourly_rate, employment_type ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .eq('id', params.id)
    .single()
  if (error || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  // Auth gate.
  const isSelf = inv.contractor_id === user.id
  const isMaster = user.role === 'master'
  let isOwnerHere = false
  if (!isMaster && !isSelf) {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    isOwnerHere = ownerLocations.includes(inv.location_id)
    if (!isOwnerHere) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  // Computed scheduled hours + estimated cost for the period.
  const computed = await computeScheduledForPeriod(db, {
    contractor_id: inv.contractor_id,
    location_id: inv.location_id,
    period_start: inv.period_start,
    period_end: inv.period_end,
  })

  return NextResponse.json({
    success: true,
    data: {
      ...inv,
      computed_scheduled: computed,
      // Convenience flags for the client to render the right view.
      viewer_role: isMaster ? 'master' : isOwnerHere ? 'owner' : 'self',
    },
  })
}
