// INTEG-B3 — tenant email sending domain (server-per-tenant).
//
//   GET  /api/settings/email-domain   — REDACTED status for the caller's org
//   POST /api/settings/email-domain   — initiate: create the org's Postmark
//                                        server + sending domain, return the
//                                        DNS records to add (NEVER the token)
//
// Access: owner-of-org or master (staff never manage it). Cross-org probes
// by non-masters answer 404, not 403 (resolveEmailDomainOrgId). The whole
// feature is gated by the custom_email_domain plan add-on — POST requires
// it (403 'add-on required'); GET returns status either way with an
// addon_active flag so the UI can show the upsell. Every handler answers
// 503 cleanly when POSTMARK_ACCOUNT_TOKEN is unset.
//
// SECRET: the server token is stored on tenant_email_domains (mig 427) and
// is NEVER returned — routes return tenantEmailStatePayload, an explicit
// allowlist that has no token field.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { isPostmarkAccountConfigured, sanitizeSendingDomain } from '@/lib/postmark-account'
import { orgHasEmailDomainAddon, tenantEmailStatePayload } from '@/lib/tenant-email'
import {
  resolveEmailDomainOrgId,
  loadEmailDomainRow,
  provisionEmailDomain,
} from '@/lib/email-domain-service'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Gate to owner-of-org or master. Staff/manager/head_coach never manage the
// sending domain (it holds a live sending credential). Returns a
// NextResponse to short-circuit, or null to continue.
function guardOwnerOrMaster(user) {
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Owner or master role required.' }, { status: 403 })
  }
  return null
}

// Resolve the org target + 503/404/403 short-circuits shared by both verbs.
// Returns { orgId, response? }.
function resolveOrgOr503(user, requested) {
  if (!isPostmarkAccountConfigured()) {
    return { response: NextResponse.json({ success: false, error: 'Email domain provisioning is not configured on this deployment.' }, { status: 503 }) }
  }
  const resolved = resolveEmailDomainOrgId(user, requested)
  if (resolved.notFound) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }
  if (!resolved.orgId) {
    return { response: NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 }) }
  }
  return { orgId: resolved.orgId }
}

// GET /api/settings/email-domain?organization_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  const guard = guardOwnerOrMaster(user)
  if (guard) return guard

  const { searchParams } = new URL(request.url)
  const { orgId, response } = resolveOrgOr503(user, searchParams.get('organization_id'))
  if (response) return response

  const db = createServerClient()
  const [row, addonActive] = await Promise.all([
    loadEmailDomainRow(db, orgId),
    orgHasEmailDomainAddon(db, orgId),
  ])
  return NextResponse.json({
    success: true,
    data: tenantEmailStatePayload(row, { addonActive, accountConfigured: true }),
  })
}

const InitiateSchema = z.object({
  organization_id: uuidLike.optional(),
  domain: z.string().trim().min(3).max(253),
  from_local: z.string().trim().max(64).optional(),
  from_name: z.string().trim().max(200).optional(),
})

// POST /api/settings/email-domain — initiate provisioning
export async function POST(request) {
  const user = await getCurrentUser()
  const guard = guardOwnerOrMaster(user)
  if (guard) return guard

  const validation = await validateBody(request, InitiateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { orgId, response } = resolveOrgOr503(user, body.organization_id)
  if (response) return response

  const db = createServerClient()

  // Add-on gate — provisioning creates PAID Postmark resources.
  const addonActive = await orgHasEmailDomainAddon(db, orgId)
  if (!addonActive) {
    return NextResponse.json(
      { success: false, error: 'The custom email domain add-on is required for this organisation.' },
      { status: 403 }
    )
  }

  // Validate the sending domain: bare, dotted hostname.
  const sendingDomain = sanitizeSendingDomain(body.domain)
  if (!sendingDomain || !sendingDomain.includes('.') || sendingDomain.length < 3) {
    return NextResponse.json(
      { success: false, error: 'Enter a valid sending domain, e.g. mail.yourgym.com.' },
      { status: 400 }
    )
  }
  const fromLocal = sanitizeSendingDomain(body.from_local || '') || 'hello'

  const orgName = user.organizationsById?.[orgId]?.name || 'tenant'

  let row
  try {
    row = await provisionEmailDomain(db, {
      orgId,
      orgName,
      sendingDomain,
      fromLocal,
      fromName: body.from_name || null,
      createdBy: user.id,
    })
  } catch (e) {
    logError('tenant-email-domain', 'provision failed', { orgId, err: e?.message })
    // Best-effort: stamp last_error so the status endpoint surfaces it.
    try {
      await db.from('tenant_email_domains')
        .update({ last_error: e?.message || 'provisioning failed', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
    } catch { /* ignore */ }
    return NextResponse.json(
      { success: false, error: e?.message || 'Could not provision the sending domain.' },
      { status: 502 }
    )
  }

  return NextResponse.json({
    success: true,
    data: tenantEmailStatePayload(row, { addonActive: true, accountConfigured: true }),
  })
}
