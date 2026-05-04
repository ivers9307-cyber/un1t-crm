// POST /api/contacts/merge
//
// Owner-only. Folds the loser contact into the survivor and
// deletes the loser. Survivor wins for every field, but the
// loser's value is copied across when the survivor's field is
// empty. Tags union. All FKs (deals, bookings, race regs,
// payments, sequence enrolments, etc.) are re-pointed at the
// survivor before the loser row is deleted.
//
// Body: { survivor_id: uuid, loser_id: uuid }
//
// Returns: { success, data: { survivor, folded } } where folded
// is a per-table count of rows that were re-pointed.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { mergeContacts } from '@/lib/contact-merge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  survivor_id: uuidLike,
  loser_id: uuidLike,
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Owner or master required' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { survivor_id, loser_id } = validation.data

  if (survivor_id === loser_id) {
    return NextResponse.json({ success: false, error: 'survivor_id and loser_id must be different' }, { status: 400 })
  }

  const db = createServerClient()
  // Check both contacts exist + are at the caller's location
  // (master bypasses). Done up front so we can return a clean 404
  // / 403 instead of a half-merged failure mid-operation.
  const { data: rows } = await db
    .from('contacts')
    .select('id, location_id, name')
    .in('id', [survivor_id, loser_id])
  if (!rows || rows.length !== 2) {
    return NextResponse.json({ success: false, error: 'One or both contacts not found' }, { status: 404 })
  }
  const [a, b] = rows
  if (a.location_id !== b.location_id) {
    return NextResponse.json({
      success: false,
      error: 'Contacts must be at the same location to merge',
    }, { status: 400 })
  }
  if (user.role !== 'master') {
    const userLocIds = (user.locations || []).map(l => l.id)
    if (!userLocIds.includes(a.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    const result = await mergeContacts(db, { survivorId: survivor_id, loserId: loser_id })
    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: e?.message || 'Merge failed',
    }, { status: 500 })
  }
}
