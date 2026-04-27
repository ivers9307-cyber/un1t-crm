import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// PUT /api/contacts/:id — Update a contact (replaces Pipedrive PUT /v1/persons/:id)
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const body = await request.json()
  const db = createServerClient()

  // Only update fields that are present in the request body
  const updates = {}
  const allowed = [
    'name', 'first_name', 'last_name', 'email', 'phone', 'label',
    'glofox_member_id', 'trial_credits_remaining', 'lead_source', 'lead_status',
  ]
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  const { data, error } = await db.from('contacts').update(updates).eq('id', id).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

// GET /api/contacts/:id
export async function GET(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const db = createServerClient()
  const { data, error } = await db.from('contacts').select('*').eq('id', id).single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
