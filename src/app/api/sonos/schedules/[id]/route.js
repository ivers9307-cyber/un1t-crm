// SONOS.15 — schedule update + delete. Location scope is enforced on the
// WHERE clause, not just read back, so a guessed id from another location
// cannot be written.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { SchedulePayload } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Patch = SchedulePayload.extend({
  override: z.object({
    state: z.literal('off'),
    until: z.string().datetime(),
  }).nullable().optional(),
})

async function authorise() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(user, 'device_control')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  return { locationId }
}

export async function PATCH(request, { params }) {
  const auth = await authorise()
  if (auth.error) return auth.error
  const { id } = await params
  // Malformed id -> 404, never 500 from a Postgres type-cast error, and
  // never 400 either — detail routes 404 so ids can't be enumerated.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const parsed = Patch.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
  }
  // Every field is optional (a PATCH sends only what changed), so `{}`
  // parses successfully — without this guard the UPDATE below would write
  // only updated_at, reading as "something changed" when nothing did.
  // Checking KEYS, not truthiness: override: null is a meaningful value
  // (it clears a suppression override) and must still count as an edit.
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ success: false, error: 'No editable fields supplied.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', auth.locationId)
    .select()
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, schedule: data })
}

export async function DELETE(request, { params }) {
  const auth = await authorise()
  if (auth.error) return auth.error
  const { id } = await params
  // Same anti-enumeration reasoning as PATCH above.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()
  const { error } = await db
    .from('sonos_schedules')
    .delete()
    .eq('id', id)
    .eq('location_id', auth.locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
