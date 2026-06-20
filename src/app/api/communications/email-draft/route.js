// PILLAR2 Phase 2 — session-authed email entry for the unified composer.
// Creates a campaign row from the composer's audience + (optionally) the
// inline-designed HTML, and sets its status per `action`:
//   - 'draft'    → status 'draft', returns id (composer opens the full editor)
//   - 'send'     → status 'queued'  (the run-campaigns cron sends it, exactly
//                  like POST /api/campaigns/[id]/send — untouched send path)
//   - 'schedule' → status 'scheduled' + scheduled_at (cron promotes at the time)
// (The existing POST /api/campaigns is Bearer-only for n8n; this is the browser
// session path, mirroring how CampaignEditor creates campaigns.)
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  audience_filter: z.unknown().optional(),
  html_content: z.string().max(1_000_000).optional(),
  design_json: z.unknown().optional(),
  action: z.enum(['draft', 'send', 'schedule']).optional(),
  scheduled_at: z.string().optional(),
  // Marketing → broadcast stream (gates on email_marketing). Utility →
  // outbound/transactional stream (gates on email_administrative, no
  // unsubscribe footer). Maps to campaigns.postmark_stream below.
  email_type: z.enum(['marketing', 'utility']).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, name, subject, audience_filter, html_content, design_json, action = 'draft', scheduled_at, email_type = 'marketing' } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }
  if (action === 'schedule' && !scheduled_at) {
    return NextResponse.json({ success: false, error: 'scheduled_at is required to schedule' }, { status: 400 })
  }

  const status = action === 'send' ? 'queued' : action === 'schedule' ? 'scheduled' : 'draft'
  const row = {
    location_id,
    name,
    subject: subject || null,
    audience_filter: audience_filter || { logic: 'and', filters: [] },
    html_content: html_content || null,
    design_json: design_json ?? null,
    status,
    created_by: user.id,
    postmark_stream: email_type === 'utility' ? 'outbound' : 'broadcast',
  }
  if (action === 'schedule') row.scheduled_at = scheduled_at

  const db = createServerClient()
  const { data, error } = await db.from('campaigns').insert(row).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, id: data.id, status })
}
