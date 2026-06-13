// POST /api/card-receipts/[id]/revoke
//
// The submitter withdraws their own still-pending receipt (e.g. wrong
// photo, duplicate). Only the submitter, only while 'submitted'.
// Terminal-but-recoverable: a fresh receipt can be submitted after.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: rec, error: loadErr } = await db
    .from('card_receipts')
    .select('id, submitter_id, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !rec) {
    return NextResponse.json({ success: false, error: 'Card receipt not found' }, { status: 404 })
  }
  if (rec.submitter_id !== user.id) {
    // Don't reveal another person's receipt — 404, not 403.
    return NextResponse.json({ success: false, error: 'Card receipt not found' }, { status: 404 })
  }
  if (rec.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot revoke a receipt in '${rec.status}' state.` },
      { status: 409 }
    )
  }

  const now = new Date().toISOString()
  const { data: revoked, error: updErr } = await db
    .from('card_receipts')
    .update({ status: 'revoked', revoked_at: now })
    .eq('id', params.id)
    .eq('status', 'submitted') // race-safe
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: 'Receipt was already actioned.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true, data: revoked })
}
