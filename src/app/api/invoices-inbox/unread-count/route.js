// INVOICES.2 — count of inbox rows awaiting operator action.
//
// Drives the red badge on the sidebar /invoices item. "Awaiting
// action" = status in ('received', 'extracted'):
//   • received  — needs quality review (stage 1)
//   • extracted — needs data review (stage 2)
//
// We deliberately exclude the intermediate states:
//   • quality_approved — async OCR is running (will land in
//     extracted shortly); if OCR failed the UI surfaces a retry
//     button on the detail screen, but it isn't an "operator
//     overdue" condition.
//   • data_approved    — Xero forward is in flight (or retrying);
//     same logic.
// Including those would make the badge flicker every time the
// pipeline transitions.
//
// Forwarded + rejected are terminal — no badge.
//
// Same permission scoping as the list endpoint: the invoices_inbox
// permission at the active location (owner + master by default,
// per-user grantable/revocable).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PENDING_STATUSES = ['received', 'extracted']

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // ORG-ISOLATION — the badge reflects the user's active studio
  // only, regardless of role. master switches active to see
  // another studio's badge. No active location set → 0 (badge has
  // no actionable target anyway). Anyone without the invoices_inbox
  // permission at the active location gets 0, not 403 — the sidebar
  // polls this for every authenticated session regardless of
  // permission, so a quiet zero keeps the client code simple.
  const activeId = user.activeLocation?.id || null
  if (!activeId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  if (!hasPermissionForLocation(user, activeId, 'invoices_inbox')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  const query = db
    .from('invoices_queue')
    .select('*', { count: 'exact', head: true })
    .in('status', PENDING_STATUSES)
    .eq('location_id', activeId)

  const { count, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { count: count || 0 } })
}
