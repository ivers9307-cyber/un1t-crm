// src/app/api/whatsapp/broadcasts/[id]/pause/route.js
// POST /api/whatsapp/broadcasts/[id]/pause — set or clear paused_at on a drip.
// { paused: true } stops the cron from picking it up; { paused: false } resumes.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { routeSignoffFor } from '@/lib/whatsapp-blast-signoff'

const PauseSchema = z.object({ paused: z.boolean() })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // GATES-2 — /send's rule: `whatsapp` somewhere, then at the broadcast's studio.
  if (!hasPermissionAtAnyLocation(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })
  }

  const validation = await validateBody(request, PauseSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('id, location_id, signed_off_by')
    .eq('id', params.id)
    .single()
  if (!broadcast) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, broadcast.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, broadcast.location_id, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden — WhatsApp not enabled' }, { status: 403 })
  }

  // WAORGNUMBER.4 (R7) — a resume restarts sending, so inside the studio's
  // sign-off window it is gated like /send: an org admin's resume signs the
  // drip off (sendDripChunk pauses an unsigned one), anyone else's resume of
  // an unsigned drip is a 403 with the spec copy. A pause is never gated.
  let stamp = {}
  if (!validation.data.paused) {
    let signoff
    try {
      signoff = await routeSignoffFor(db, { user, locationId: broadcast.location_id, row: broadcast })
    } catch {
      return NextResponse.json({ success: false, error: 'Could not check whether this broadcast needs sign-off. Try again.' }, { status: 503 })
    }
    if (signoff.blocked) return NextResponse.json({ success: false, error: signoff.blocked, signoff_required: true }, { status: 403 })
    stamp = signoff.stamp || {}
  }

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update({ paused_at: validation.data.paused ? new Date().toISOString() : null, ...stamp })
    .eq('id', params.id)
    .select('id, paused_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}
