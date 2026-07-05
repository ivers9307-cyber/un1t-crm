// src/app/api/accounting/mailboxes/[id]/route.js
//
// RCOV.P1 — remove a hunt inbox. Per-location (mig 374): the delete is
// scoped to the active location, so one location can't remove another's
// inbox. 404 — not 403 — on a missing id or an id owned by a different
// location, per the repo's IDOR posture.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: deleted, error } = await db
    .from('recon_mailboxes')
    .delete()
    .eq('id', params.id)
    .eq('location_id', locationId)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[accounting/mailboxes] delete failed:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  if (!deleted) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  return NextResponse.json({ success: true })
}
