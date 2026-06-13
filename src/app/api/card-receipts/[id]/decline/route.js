// POST /api/card-receipts/[id]/decline
//
// Owner/master at the receipt's location declines a submitted receipt
// with a required reason. Terminal-but-recoverable: the submitter can
// submit a fresh receipt for the same purchase.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

const DeclineSchema = z.object({
  reason: z.string().min(1).max(1000),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, DeclineSchema)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const db = createServerClient()
  const { data: rec, error: loadErr } = await db
    .from('card_receipts')
    .select('id, location_id, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !rec) {
    return NextResponse.json({ success: false, error: 'Card receipt not found' }, { status: 404 })
  }
  if (rec.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot decline a receipt in '${rec.status}' state.` },
      { status: 409 }
    )
  }

  if (user.role !== 'master') {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (!ownerLocations.includes(rec.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const now = new Date().toISOString()
  const { data: declined, error: updErr } = await db
    .from('card_receipts')
    .update({
      status: 'declined',
      reviewed_by: user.id,
      reviewed_at: now,
      declined_at: now,
      decline_reason: reason.trim(),
    })
    .eq('id', params.id)
    .eq('status', 'submitted') // race-safe
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!declined) {
    return NextResponse.json(
      { success: false, error: 'Receipt was already actioned by someone else.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true, data: declined })
}
