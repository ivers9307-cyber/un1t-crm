// src/app/api/accounting/mailboxes/[id]/route.js
//
// RCOV.P1 — remove a hunt inbox. Global resource (no location_id),
// same accounting_hub-only guard as the list route. 404 — not 403 —
// on a missing/already-removed id, per the repo's IDOR posture.
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

  const db = createServerClient()
  const { data: deleted, error } = await db
    .from('recon_mailboxes')
    .delete()
    .eq('id', params.id)
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[accounting/mailboxes] delete failed:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  if (!deleted) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  return NextResponse.json({ success: true })
}
