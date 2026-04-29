import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/campaigns — List campaigns
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const status = searchParams.get('status')

  let query = db.from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query.limit(50)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// POST /api/campaigns — Create a campaign
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const { data, error } = await db.from('campaigns').insert({
    location_id: body.location_id,
    name: body.name,
    subject: body.subject || '',
    preview_text: body.preview_text || null,
    from_name: body.from_name || null,
    from_email: body.from_email || null,
    reply_to: body.reply_to || null,
    design_json: body.design_json || null,
    html_content: body.html_content || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    status: 'draft',
    template_id: body.template_id || null,
    created_by: body.created_by || null,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
