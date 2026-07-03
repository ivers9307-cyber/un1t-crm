// POST /api/pulse/journey/touch
//
// PULSE-90.2 — a coach logs that they reached out to a journey member
// ("Log touch" on the /pulse lane). Body: { contact_id, note? }.
//
// Writes a churn_radar_actions row with action='contacted' — the exact
// audit shape /api/churn-radar/action writes — so one action log powers
// "who's been contacted" on BOTH the journey lane (lastTouch overlay in
// loadJourneyLane) and the churn radar. 'contacted' is already in the
// table's action CHECK; no migration needed.
//
// Access: pulse_admin permission. The contact must belong to the caller's
// active location — a cross-tenant id returns 404 (not 403) so contact ids
// can't be enumerated.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const JourneyTouchSchema = z.object({
  contact_id: uuidLike,
  note: z.string().max(500).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'pulse_admin')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const validation = await validateBody(request, JourneyTouchSchema)
  if (!validation.ok) return validation.response
  const contactId = validation.data.contact_id
  const note = validation.data.note?.trim() || 'Pulse journey touch'

  const db = createServerClient()

  // Scope the contact to the caller's active location (404, never 403).
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact || contact.location_id !== locationId) {
    return NextResponse.json({ success: false, error: 'Contact not in your active location' }, { status: 404 })
  }

  const at = new Date().toISOString()
  const { error: logErr } = await db.from('churn_radar_actions').insert({
    contact_id: contactId,
    location_id: locationId,
    action: 'contacted',
    note,
    actor_id: user.id,
  })
  if (logErr) {
    logWarn('pulse-journey', 'touch insert failed', { err: logErr, contactId })
    return NextResponse.json({ success: false, error: logErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { action: 'contacted', at } })
}
