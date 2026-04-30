import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate , MANAGER_ROLES} from '@/lib/schemas'

const PublishSchema = z.object({
  location_id: uuidLike,
  start_date: isoDate,
  end_date: isoDate,
  notify: z.boolean().optional(),
})

// POST /api/schedule/shifts/publish
// Publish all shifts for a given week at a location
// Body: { location_id, start_date, end_date, notify: true/false }
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PublishSchema)
  if (!validation.ok) return validation.response
  const { location_id, start_date, end_date, notify } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()

  // Publish all unpublished shifts in the range
  const { data: shifts, error } = await db.from('shifts')
    .update({ published: true, published_at: new Date().toISOString() })
    .eq('location_id', location_id)
    .gte('shift_date', start_date)
    .lte('shift_date', end_date)
    .eq('published', false)
    .select('*, profiles!profile_id(id, full_name, email)')

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // If notify requested, log notification records (actual sending via Postmark/WhatsApp
  // can be triggered by n8n watching this table or a separate cron)
  if (notify && shifts && shifts.length > 0) {
    // Group shifts by profile to send one notification per person
    const profileShifts = {}
    for (const s of shifts) {
      if (!profileShifts[s.profile_id]) profileShifts[s.profile_id] = []
      profileShifts[s.profile_id].push(s)
    }

    const notifications = Object.entries(profileShifts).map(([profileId, pShifts]) => ({
      profile_id: profileId,
      shift_id: pShifts[0].id,
      type: 'roster_published',
      channel: 'email',
      metadata: {
        week_start: start_date,
        week_end: end_date,
        shift_count: pShifts.length,
      },
    }))

    await db.from('schedule_notifications').insert(notifications)
  }

  return NextResponse.json({ success: true, published: shifts?.length || 0 })
}
