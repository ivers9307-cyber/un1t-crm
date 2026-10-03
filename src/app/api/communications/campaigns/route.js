// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns: create a draft
// email campaign from the campaign editor (session auth).
//
// Replaces CampaignEditor's browser-direct INSERT into campaigns, which ran
// under nothing but the mig 014 membership policy: any studio member could
// create a campaign, created_by was whatever the browser sent, and the
// audience filter was never validated. /api/campaigns POST is Bearer-only
// (n8n); /api/communications/email-draft is the composer's path. Gate (D7):
// email at the body's studio, as the page that renders the editor.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import {
  CampaignCreateSchema, contentPatch, audienceFilterRefusal, NO_EMAIL, serverError,
} from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, CampaignCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccessOr404(user, body.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, body.location_id, 'email')) return NO_EMAIL()

  const refusal = audienceFilterRefusal(body.audience_filter)
  if (refusal) return refusal

  const row = {
    ...contentPatch(body),
    subject: body.subject ?? '',
    location_id: body.location_id,
    status: 'draft',
    created_by: user.id,
  }

  const db = createServerClient()
  const { data, error } = await db.from('campaigns')
    .insert(row)
    .select('id, status, location_id')
    .single()
  if (error || !data) return serverError(error?.message || 'Could not create the campaign')

  return NextResponse.json({ success: true, data })
}
