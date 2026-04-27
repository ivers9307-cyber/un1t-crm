import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// POST /api/notes — Create a note (replaces Pipedrive POST /v1/notes)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const { data, error } = await db.from('notes').insert({
    contact_id: body.contact_id || body.person_id,  // accept either name
    deal_id: body.deal_id,
    content: body.content,
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
