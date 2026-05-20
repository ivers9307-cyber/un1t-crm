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
// Same role scoping as the list endpoint: master sees every
// location; owner sees their own; staff get 403.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PENDING_STATUSES = ['received', 'extracted']

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const isMaster = user.role === 'master' || user.profileRole === 'master'
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)

  // Anyone without master + without owner-at-some-location gets 0.
  // Don't 403 — the sidebar polls this for every authenticated
  // session regardless of permission, so a quiet zero keeps the
  // client code simple.
  if (!isMaster && ownerLocations.length === 0) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  // ORG-ISOLATION — the badge reflects the user's active studio
  // only, regardless of role. master switches active to see
  // another studio's badge. No active location set → 0 (badge has
  // no actionable target anyway). Non-owner viewing a non-owned
  // active location → 0 (e.g. a manager visiting another studio).
  const activeId = user.activeLocation?.id || null
  if (!activeId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  if (!isMaster && !ownerLocations.includes(activeId)) {
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
