import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay, activityTypeSchema } from '@/lib/schemas'

const ActivityCreateSchema = z.object({
  subject: z.string().min(1).max(500),
  type: activityTypeSchema.optional(),
  contact_id: uuidLike.optional(),
  person_id: uuidLike.optional(),
  deal_id: uuidLike.nullable().optional(),
  due_date: isoDate.nullable().optional(),
  due_time: timeOfDay.nullable().optional(),
  note: z.string().max(20_000).nullable().optional(),
  done: z.boolean().optional(),
  location_id: uuidLike.optional(),
})

// POST /api/activities — Create an activity (replaces Pipedrive POST /v1/activities)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const validation = await validateBody(request, ActivityCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  const { data, error } = await db.from('activities').insert({
    subject: body.subject,
    type: body.type || 'call',
    contact_id: body.contact_id || body.person_id,  // accept either name
    deal_id: body.deal_id,
    due_date: body.due_date,
    due_time: body.due_time,
    note: body.note,
    done: body.done || false,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
