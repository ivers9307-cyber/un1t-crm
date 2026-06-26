// POST /api/presentations/[id]/advance  { index }  → set current_index, bump version
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { clampIndex } from '@/lib/presentations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ index: z.number().int() })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { count } = await db.from('presentation_slides')
    .select('id', { count: 'exact', head: true }).eq('presentation_id', id)
  const next = clampIndex(validation.data.index, count || 0)
  const { data, error } = await db
    .rpc('bump_presentation_version', { p_presentation_id: id, p_current_index: next })
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, current_index: data.current_index, version: data.version })
}
