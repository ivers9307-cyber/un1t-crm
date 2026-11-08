// /api/host/events/[id]/duplicate — HOSTSERIES.1
//
// POST — a host copies ONE of their own events to a new date as a draft
// (duplicateEvent: fields, waves, shifted registration window, its own hero
// file; never registrations or promo codes). The source must be the host's
// (404 otherwise, so ids cannot be enumerated across hosts).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { duplicateEvent, DUPLICATE_ERRORS } from '@/lib/event-duplicate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DuplicateBodySchema = z.object({
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db.from('race_events').select('id, host_id').eq('id', params.id).maybeSingle()
  if (!race || race.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const validation = await validateBody(request, DuplicateBodySchema)
  if (!validation.ok) return validation.response

  const result = await duplicateEvent(db, { sourceId: race.id, raceDate: validation.data.race_date })
  if (!result.ok) {
    const status = result.error === DUPLICATE_ERRORS.NOT_FOUND ? 404 : 500
    return NextResponse.json({ success: false, error: result.message, code: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.event })
}
