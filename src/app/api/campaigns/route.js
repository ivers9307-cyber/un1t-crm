import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, scopeQueryToOrg, assertCreateInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, email, audienceFilterSchema } from '@/lib/schemas'

const CampaignCreateSchema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  template_id: uuidLike.nullable().optional(),
  created_by: uuidLike.nullable().optional(),
})

// GET /api/campaigns — List campaigns
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const status = searchParams.get('status')

  let query = db.from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)
  if (status) query = query.eq('status', status)
  // APIKEYS.3 — per-org key: restrict to the org's locations.
  query = await scopeQueryToOrg(query, db, auth.orgId)

  const { data, error } = await query.limit(50)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// POST /api/campaigns — Create a campaign
export async function POST(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, CampaignCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only create a campaign at a location in its org.
  const scopeErr = await assertCreateInOrg({ db, orgId: auth.orgId, locationId: body.location_id })
  if (scopeErr) return scopeErr

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
