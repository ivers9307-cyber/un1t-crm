// SAAS4-M3 — org usage summary + hard-cap management (SaaS machinery
// plan §3). Read side feeds /settings/usage: live cap-relevant numbers
// (AI spend, email sends — the mig 421 RPCs) plus month-to-date meter
// totals and a per-location split from usage_rollups_daily (nightly).
// Write side sets/clears the two OPTIONAL hard caps on org_settings.
//
// Access (C18 ORGROLE.1, Richard 1 Oct 2026): organisation admins only,
// for the read and the caps alike — master targets any org (defaults to
// active), an org admin (org_admin grant) only the orgs they administer. A
// studio owner is not an org admin; the read used to admit ADMIN_ROLES
// (managers included) at the active studio.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { isOrgAdminSomewhere, resolveAdminOrgId } from '@/lib/org-admin'
import { validateBody, uuidLike } from '@/lib/validate'
import { getOrgUsageSummary } from '@/lib/usage-summary'
import { parseOpsAlertEmails } from '@/lib/ops-alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function resolveOrgId(user, requested) {
  return resolveAdminOrgId(user, requested).orgId || null
}

// GET /api/settings/org-usage?organization_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const orgId = resolveOrgId(user, searchParams.get('organization_id'))
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  const db = createServerClient()
  const data = await getOrgUsageSummary(db, orgId)
  return NextResponse.json({ success: true, data })
}

const CapsSchema = z.object({
  organization_id: uuidLike.optional(),
  // null clears a cap; positive number sets it.
  ai_hard_cap_cents: z.number().positive().nullable().optional(),
  // ASSISTCAP.1 — the staff assistant's OWN cap, separate from Mia's above.
  assistant_hard_cap_cents: z.number().positive().nullable().optional(),
  email_hard_cap_sends: z.number().int().positive().nullable().optional(),
  // SAAS4-O2 — ops alert recipients. Comma string or array; normalised
  // server-side; null/empty clears (master-push fallback resumes).
  ops_alert_emails: z.union([z.string().max(2000), z.array(z.string().email()).max(20)]).nullable().optional(),
  // VOICENOTE.1 — transcribe WhatsApp voice notes (ElevenLabs), and the
  // optional monthly cap in minutes (null clears it: no cap).
  voice_transcription_enabled: z.boolean().optional(),
  voice_transcription_monthly_cap_minutes: z.number().int().positive().max(100000).nullable().optional(),
  // VOICEREPLY.1 — Mia's voice replies: off, test numbers only, or on, and an
  // optional monthly limit in voice replies (null clears it).
  voice_reply_mode: z.enum(['off', 'test', 'on']).optional(),
  voice_reply_test_phones: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  voice_reply_monthly_cap: z.number().int().positive().max(100000).nullable().optional(),
})

// PUT /api/settings/org-usage — set/clear the org hard caps (organisation admin)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Only organisation admins can change usage caps' }, { status: 403 })
  }

  const validation = await validateBody(request, CapsSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const orgId = resolveOrgId(user, body.organization_id)
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  const patch = { organization_id: orgId, updated_at: new Date().toISOString(), updated_by: user.id }
  if ('ai_hard_cap_cents' in body) patch.ai_hard_cap_cents = body.ai_hard_cap_cents
  if ('assistant_hard_cap_cents' in body) patch.assistant_hard_cap_cents = body.assistant_hard_cap_cents
  if ('email_hard_cap_sends' in body) patch.email_hard_cap_sends = body.email_hard_cap_sends
  if ('voice_transcription_enabled' in body) patch.voice_transcription_enabled = body.voice_transcription_enabled
  if ('voice_transcription_monthly_cap_minutes' in body) patch.voice_transcription_monthly_cap_minutes = body.voice_transcription_monthly_cap_minutes
  if ('voice_reply_mode' in body) patch.voice_reply_mode = body.voice_reply_mode
  if ('voice_reply_test_phones' in body) patch.voice_reply_test_phones = body.voice_reply_test_phones
  if ('voice_reply_monthly_cap' in body) patch.voice_reply_monthly_cap = body.voice_reply_monthly_cap
  if ('ops_alert_emails' in body) {
    const emails = parseOpsAlertEmails(body.ops_alert_emails)
    patch.ops_alert_emails = emails.length > 0 ? emails : null
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('org_settings')
    .upsert(patch, { onConflict: 'organization_id' })
    .select('ai_hard_cap_cents, assistant_hard_cap_cents, email_hard_cap_sends, ops_alert_emails, voice_transcription_enabled, voice_transcription_monthly_cap_minutes, voice_reply_mode, voice_reply_test_phones, voice_reply_monthly_cap')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
