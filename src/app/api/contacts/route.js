import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, email, phone, leadSourceSchema, leadStatusSchema, MANAGER_ROLES } from '@/lib/schemas'
import { sendPushToRolesAtLocation } from '@/lib/push'

const ContactCreateSchema = z.object({
  name: z.string().min(1).max(200),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email,
  phone: phone.optional().nullable(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional(),
  lead_source: leadSourceSchema.optional(),
  lead_status: leadStatusSchema.optional(),
  lead_created_at: z.string().datetime().optional(),
  location_id: uuidLike.optional(),
})

// POST /api/contacts — Create a contact (replaces Pipedrive POST /v1/persons)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const validation = await validateBody(request, ContactCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  const { data, error } = await db.from('contacts').insert({
    name: body.name,
    first_name: body.first_name || body.name?.split(' ')[0],
    last_name: body.last_name || body.name?.split(' ').slice(1).join(' '),
    email: body.email,
    phone: body.phone,
    label: body.label,
    glofox_member_id: body.glofox_member_id,
    trial_credits_remaining: body.trial_credits_remaining ?? 3,
    lead_source: body.lead_source,
    lead_status: body.lead_status || 'active_trial',
    lead_created_at: body.lead_created_at || new Date().toISOString(),
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Push notification: a new lead has landed. Fan out to managers /
  // head-coaches at the contact's location. Per-user opt-in via
  // permissions.mobile.notify_lead inside sendPush(). Best-effort.
  if (data.location_id) {
    const sourceLabel = data.lead_source ? ` from ${data.lead_source}` : ''
    sendPushToRolesAtLocation(
      data.location_id,
      MANAGER_ROLES,
      {
        title: 'New lead',
        body: `${data.name}${sourceLabel}. Tap to view.`,
        category: 'lead',
        data: {
          type: 'lead_new',
          contact_id: data.id,
        },
      }
    ).catch(err => console.error('[contacts] push failed', err))
  }

  // Return in a shape similar to Pipedrive for easy n8n migration
  return NextResponse.json({ success: true, data })
}

// GET /api/contacts — List contacts with optional filters
// Query params: lead_status, lead_source, limit, offset
// Replaces Pipedrive GET /v1/persons?filter_id=X
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  // Location filter
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)

  // Filters
  const status = searchParams.get('lead_status')
  if (status) query = query.eq('lead_status', status)

  const source = searchParams.get('lead_source')
  if (source) query = query.eq('lead_source', source)

  // Credits filter (replaces Pipedrive saved filter for active trials)
  const minCredits = searchParams.get('min_credits')
  if (minCredits) query = query.gt('trial_credits_remaining', parseInt(minCredits))

  // Pagination — default 50, hard cap at 200 to prevent a caller from
  // pulling the whole table with ?limit=10000.
  const requestedLimit = parseInt(searchParams.get('limit') || '50', 10)
  const limit = Math.min(Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50), 200)
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0)
  query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false })

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
