// PILLAR2 Phase 2 — session-authed email entry for the unified composer.
// Creates a campaign row from the composer's audience + (optionally) the
// inline-designed HTML, and sets its status per `action`:
//   - 'draft'    → status 'draft', returns id (composer opens the full editor)
//   - 'send'     → status 'queued'  (the run-campaigns cron sends it, exactly
//                  like POST /api/campaigns/[id]/send — untouched send path)
//   - 'schedule' → status 'scheduled' + scheduled_at (cron promotes at the time)
// (The existing POST /api/campaigns is Bearer-only (per-org API key); this is the browser
// session path, mirroring how CampaignEditor creates campaigns.)
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { releasePreflight, releaseCampaign } from '@/lib/campaign-release'

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
  // CAMPAIGN-RESEND (mig 506) — auto-resend to non-openers. Marketing
  // only (enforced below — outbound has no open tracking); bounds mirror
  // the DB CHECK on resend_wait_hours.
  resend_enabled: z.boolean().optional(),
  resend_wait_hours: z.number().int().min(1).max(168).optional(),
  resend_subject: z.string().max(500).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, name, subject, audience_filter, html_content, design_json, action = 'draft', scheduled_at, email_type = 'marketing', resend_enabled, resend_wait_hours, resend_subject } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }
  if (action === 'schedule' && !scheduled_at) {
    return NextResponse.json({ success: false, error: 'scheduled_at is required to schedule' }, { status: 400 })
  }
  // COMMSFIX.B.7 — reject an invalid audience filter at save time instead of
  // parking a campaign that can never populate (it wedges 'queued' forever).
  try {
    validateAudienceFilter(audience_filter)
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }

  // COMMSFIX.D.2d — server backstop against a bodyless broadcast. A blank
  // export used to arrive here as html_content '' and be stored as NULL, then
  // queued: Postmark permanently rejects HtmlBody null, so the entire audience
  // records as bounced. A DRAFT may legitimately be empty; a send or a
  // schedule may not. Audit 2026-08-09 composer-ux, CONFIRMED high.
  //
  // Sibling of the B.7 check above — one refuses an audience that can never
  // resolve, the other content that can never deliver. Both exist because the
  // composer could fire either past the client-side gates.
  if (action === 'send' || action === 'schedule') {
    if (!subject || !subject.trim()) {
      return NextResponse.json({ success: false, error: 'A subject is required to send or schedule this campaign' }, { status: 400 })
    }
    if (!html_content || !html_content.trim()) {
      return NextResponse.json({ success: false, error: 'The email body is empty — nothing was queued. Wait for the designer to load, then send again.' }, { status: 400 })
    }
  }
  // CAMPAIGN-RESEND — marketing only (the outbound stream has open
  // tracking off by design, so "didn't open" is unknowable there), and a
  // wait is required so the spawner has a real deadline.
  if (resend_enabled) {
    if (email_type === 'utility') {
      return NextResponse.json({ success: false, error: 'Resend to non-openers is only available for marketing emails' }, { status: 400 })
    }
    if (!resend_wait_hours) {
      return NextResponse.json({ success: false, error: 'resend_wait_hours is required when resend is enabled' }, { status: 400 })
    }
  }

  // MAILPREFLIGHT.1 (audit 2026-11-15, item 8): the composer used to insert
  // 'queued' / 'scheduled' directly, skipping releasePreflight, so a send
  // went out past the org's email hard cap and an empty prepaid wallet (the
  // run-campaigns cron checks the cap only when it promotes a scheduled
  // campaign, never for a queued one). Now the row is always created as a
  // draft and released through the same two functions the editor's Send and
  // Schedule use. A refused release leaves the draft, so nothing is lost.
  let sendAt = null
  if (action === 'schedule') {
    sendAt = new Date(scheduled_at)
    if (Number.isNaN(sendAt.getTime())) {
      return NextResponse.json({ success: false, error: 'scheduled_at is not a valid date' }, { status: 400 })
    }
  }
  const status = 'draft'
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
  if (resend_enabled) {
    row.resend_enabled = true
    row.resend_wait_hours = resend_wait_hours
    row.resend_subject = resend_subject || null
  }

  const db = createServerClient()
  const { data, error } = await db.from('campaigns').insert(row).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  if (action === 'draft') return NextResponse.json({ success: true, id: data.id, status: 'draft' })

  const campaign = { ...row, id: data.id }
  const preflight = await releasePreflight(db, campaign)
  if (!preflight.ok) {
    // Same codes and status as POST /api/campaigns/[id]/send. The draft is
    // kept: the operator fixes the cause and sends it from the editor.
    const status422 = preflight.code === 'email_hard_cap' || preflight.code === 'wallet_empty'
    return NextResponse.json(
      { success: false, error: `${preflight.message} The email was saved as a draft.`, code: preflight.code, id: data.id, status: 'draft' },
      { status: status422 ? 422 : 400 },
    )
  }
  const release = await releaseCampaign(db, campaign, { sendAt })
  if (!release.ok) {
    return NextResponse.json(
      { success: false, error: `${release.message} The email was saved as a draft.`, code: release.code, id: data.id, status: 'draft' },
      { status: release.code === 'conflict' ? 409 : 500 },
    )
  }
  return NextResponse.json({ success: true, id: data.id, status: release.status })
}
