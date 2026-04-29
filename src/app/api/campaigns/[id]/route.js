import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/campaigns/[id] — Get campaign with metrics
export async function GET(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db.from('campaigns')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}

// PUT /api/campaigns/[id] — Update campaign (only drafts)
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const updates = {}
  const allowed = ['name', 'subject', 'preview_text', 'from_name', 'from_email', 'reply_to',
    'design_json', 'html_content', 'audience_filter', 'scheduled_at', 'template_id', 'status']

  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  const { data, error } = await db.from('campaigns')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// DELETE /api/campaigns/[id]
export async function DELETE(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { error } = await db.from('campaigns').delete().eq('id', params.id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
