// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns: create a draft
// email campaign from the campaign editor (session auth).
//
// Replaces CampaignEditor's browser-direct INSERT into campaigns, which ran
// under nothing but the mig 014 membership policy: any studio member could
// create a campaign, created_by was whatever the browser sent, and the
// audience filter was never validated. /api/campaigns POST is Bearer-only
// (per-org API key); /api/communications/email-draft is the composer's path. Gate (D7):
// email at the body's studio, as the page that renders the editor.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { loadMarketingTemplate } from '@/lib/email-templates-for-agents'
import { logError } from '@/lib/log'
import {
  CampaignCreateSchema, contentPatch, audienceFilterRefusal, resendRefusal, NO_EMAIL, serverError,
} from '@/lib/campaign-session-access'
import { fromAddressReport } from '@/lib/from-address'

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
  // EDITORRESEND.1 — resend is marketing only and needs a wait.
  const resend = resendRefusal(body)
  if (resend.error) return NextResponse.json({ success: false, error: resend.error }, { status: 400 })

  const db = createServerClient()

  // NEWEMAIL.1 — a template is one of THIS studio's marketing templates
  // (loadMarketingTemplate refuses another studio's, a confirmation or
  // reminder, and one an event or race points at). A failed read is a 503,
  // never a blank draft passed off as the template.
  let template = null
  if (body.template_id) {
    try {
      template = await loadMarketingTemplate(db, body.location_id, body.template_id)
    } catch (err) {
      logError('communications', 'template read failed on create', { err, templateId: body.template_id })
      return NextResponse.json({ success: false, error: 'Could not read that template. Try again.' }, { status: 503 })
    }
    if (!template) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  const row = {
    ...contentPatch(body),
    ...resend.patch,
    ...(template ? {
      template_id: template.id,
      html_content: body.html_content ?? template.html_content,
      design_json: body.design_json ?? template.design_json,
    } : {}),
    subject: body.subject ?? template?.subject ?? '',
    location_id: body.location_id,
    status: 'draft',
    created_by: user.id,
  }

  const { data, error } = await db.from('campaigns')
    .insert(row)
    .select('id, status, location_id')
    .single()
  if (error || !data) return serverError(error?.message || 'Could not create the campaign')

  // FROMDOMAIN — from_email is stored as given but SENT only when it is on the
  // org's verified sending domain; the editor reads `from_address` to say so.
  const from_address = await fromAddressReport(db, body.location_id, body)
  return NextResponse.json({ success: true, data, ...(from_address ? { from_address } : {}) })
}
