import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// POST /api/activities — Create an activity (replaces Pipedrive POST /v1/activities)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
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
