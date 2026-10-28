// POST /api/corp-promo-claims/[id]/handled — CORPPROMO.1: close a /corp claim
// whose free credits needed a hand (status help_requested → handled), once
// staff have checked the person's un1t.online account. No email, nothing
// sent to un1t.online.
//
// Gated on approvals_offer_purchases (the same people who handle the paid
// trial help cards), judged at the claim's studio. Detail-route semantics: an
// id outside the caller's studios answers 404, not 403.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'approvals_offer_purchases')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const { data: row, error: readErr } = await db
    .from('corp_promo_claims')
    .select('id, location_id, status')
    .eq('id', id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ success: false, error: 'read_failed' }, { status: 503 })
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, row.location_id, 'approvals_offer_purchases')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (row.status === 'handled') return NextResponse.json({ success: true, data: { already: true, status: 'handled' } })
  if (row.status !== 'help_requested') return NextResponse.json({ success: false, error: 'not_open', status: row.status }, { status: 409 })
  const { data: upd, error } = await db
    .from('corp_promo_claims')
    .update({ status: 'handled', handled_by: user.id, handled_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', row.location_id)
    .eq('status', 'help_requested')
    .select('id')
  if (error) return NextResponse.json({ success: false, error: 'write_failed' }, { status: 500 })
  if (!upd || upd.length === 0) return NextResponse.json({ success: false, error: 'not_open' }, { status: 409 })
  return NextResponse.json({ success: true, data: { status: 'handled' } })
}
