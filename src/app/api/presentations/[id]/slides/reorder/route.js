// PUT /api/presentations/[id]/slides/reorder  { order: [slideId, …] }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ order: z.array(uuidLike).min(1) })

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
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
  // Rewrite positions to match the given order. Only slides on this deck.
  for (let i = 0; i < order.length; i++) {
    await db.from('presentation_slides').update({ position: i }).eq('id', order[i]).eq('presentation_id', id)
  }
  await db.rpc('bump_presentation_version', { p_presentation_id: id })
  return NextResponse.json({ success: true })
}
