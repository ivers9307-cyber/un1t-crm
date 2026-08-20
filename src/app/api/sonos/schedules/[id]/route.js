// SONOS.15 — schedule update + delete. Location scope is enforced on the
// WHERE clause, not just read back, so a guessed id from another location
// cannot be written.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
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

  const parsed = Patch.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
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

  const db = createServerClient()
  const { error } = await db
    .from('sonos_schedules')
    .delete()
    .eq('id', id)
    .eq('location_id', auth.locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
