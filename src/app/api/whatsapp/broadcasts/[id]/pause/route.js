// src/app/api/whatsapp/broadcasts/[id]/pause/route.js
// POST /api/whatsapp/broadcasts/[id]/pause — set or clear paused_at on a drip.
// { paused: true } stops the cron from picking it up; { paused: false } resumes.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const PauseSchema = z.object({ paused: z.boolean() })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, PauseSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!broadcast) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })

  const guard = assertLocationAccess(user, broadcast.location_id)
  if (guard) return guard

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update({ paused_at: validation.data.paused ? new Date().toISOString() : null })
    .eq('id', params.id)
    .select('id, paused_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}
