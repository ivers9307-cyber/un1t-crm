import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, requireApiKeyOrManager, orgLocationIds } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, email, phone, leadSourceSchema, MANAGER_ROLES } from '@/lib/schemas'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { triggerSequencesForPipelineStageChange } from '@/lib/sequences'
import { logWarn } from '@/lib/log'

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
  lead_created_at: z.string().datetime().optional(),
  location_id: uuidLike.optional(),
})

// POST /api/contacts — Create a contact.
//
// Originally a pipedrive-replacement n8n endpoint (API-key only).
// Now also callable from the web UI (manager+ via cookie). Web
// callers default location_id to their active location if they
// didn't provide one.
export async function POST(request) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, ContactCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  // Web callers usually omit location_id — fall back to their
  // active location. n8n callers always supply it explicitly.
  if (!body.location_id && auth.user?.activeLocation?.id) {
    body.location_id = auth.user.activeLocation.id
  }
  const db = createServerClient()

  // APIKEYS.3 — a per-org key may only create contacts at a location
  // within its organization. Legacy shared key + cookie managers have
  // orgId null and are unchanged.
  if (auth.orgId) {
    if (!body.location_id) {
      return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })
    }
    const locIds = await orgLocationIds(db, auth.orgId)
    if (!locIds.includes(body.location_id)) {
      return NextResponse.json({ success: false, error: 'location not in your organization' }, { status: 403 })
    }
  }

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
    lead_created_at: body.lead_created_at || new Date().toISOString(),
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Fire the pipeline_stage_change sequence trigger with oldStage=null
  // so any "when contact becomes X" sequence picks the new
  // contact up. Best-effort — never blocks the create response.
  try {
    await triggerSequencesForPipelineStageChange(data.id, null, data.pipeline_stage_slug)
  } catch (e) {
    logWarn('contacts', `insert trigger failed for ${data.id}`, { err: e })
  }

  // AUTOMATIONS: glofox_lead_provisioning. Link-only dup-check today;
  // create-and-trial when the per-location automation is enabled.
  if (data.location_id && data.email && !data.glofox_member_id) {
    const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
    maybeProvisionLeadInGlofox({ db, locationId: data.location_id, contact: data, source: 'manual' })
      .catch(() => {}) // hook never throws, but belt-and-braces
  }
  // AUTOMATIONS Phase 1 — fire any custom contact_created automations (best-effort).
  const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
  triggerSequencesForContactCreated(data.id)

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
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  // APIKEYS.3 — per-org key: restrict to the org's own locations so a
  // leaked key can't read another org's contacts. Legacy shared key
  // (orgId null) stays unscoped — unchanged until n8n migrates.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    // Empty org → match nothing (sentinel uuid) rather than everything.
    query = query.in('location_id', locIds.length ? locIds : ['00000000-0000-0000-0000-000000000000'])
  }

  // Location filter
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)

  // Filters
  // Accepts ?lead_status= or ?pipeline_stage_slug= for the canonical
  // stage slug (CLASSIFY.2 — old name kept as alias for n8n/back-compat).
  const status = searchParams.get('pipeline_stage_slug') || searchParams.get('lead_status')
  if (status) query = query.eq('pipeline_stage_slug', status)

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
