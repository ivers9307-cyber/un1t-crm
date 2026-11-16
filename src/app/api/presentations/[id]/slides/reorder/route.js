// PUT /api/presentations/[id]/slides/reorder  { order: [slideId, …] }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateDeckOrder } from '@/lib/presentations'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ order: z.array(uuidLike).min(1) })

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermissionAtAnyLocation(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { order } = validation.data
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // ROLESWEEP.1a — the permission is judged at the deck's location.
  if (!hasPermissionForLocation(user, deck.location_id, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  // PRESENTSAFE.1 (October audit A18) — the order must be the whole deck,
  // each slide once; every write is judged, and the version is bumped even
  // after a partial failure so open screens re-read what was saved.
  const { data: slides, error: slidesErr } = await db.from('presentation_slides').select('id').eq('presentation_id', id)
  if (slidesErr) return NextResponse.json({ success: false, error: 'Could not read the slides. Try again.' }, { status: 503 })
  const valid = validateDeckOrder(order, (slides || []).map((r) => r.id))
  if (!valid.ok) return NextResponse.json({ success: false, error: valid.error }, { status: 400 })

  let failed = 0
  for (let i = 0; i < order.length; i++) {
    const { error } = await db.from('presentation_slides').update({ position: i }).eq('id', order[i]).eq('presentation_id', id)
    if (error) failed++
  }
  const { error: bumpErr } = await db.rpc('bump_presentation_version', { p_presentation_id: id })
  if (failed || bumpErr) {
    logError('presentations', 'reorder not fully saved', { presentationId: id, failed, bumpError: bumpErr?.message || null })
    return NextResponse.json({ success: false, error: 'The new order was not fully saved. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
