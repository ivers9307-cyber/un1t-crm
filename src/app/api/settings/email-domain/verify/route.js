// INTEG-B3 — POST /api/settings/email-domain/verify
//
// Trigger a Postmark re-check of the org's sending domain (DKIM +
// Return-Path); when both verify, flip status → 'live'. IDEMPOTENT.
//
// Access: owner-of-org or master (same gate as the parent route). Operates
// on an ALREADY-provisioned row (409 if none) — the add-on gate lives on
// the initiate route; a provisioned domain stays verifiable so a live org
// can re-confirm DNS. 503 when POSTMARK_ACCOUNT_TOKEN is unset. The server
// token is never returned (redacted status payload).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { isPostmarkAccountConfigured } from '@/lib/postmark-account'
import { orgHasEmailDomainAddon, tenantEmailStatePayload } from '@/lib/tenant-email'
import { resolveEmailDomainOrgId, verifyEmailDomain } from '@/lib/email-domain-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VerifySchema = z.object({
  organization_id: uuidLike.optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Owner or master role required.' }, { status: 403 })
  }

  const validation = await validateBody(request, VerifySchema)
  if (!validation.ok) return validation.response

  if (!isPostmarkAccountConfigured()) {
    return NextResponse.json({ success: false, error: 'Email domain provisioning is not configured on this deployment.' }, { status: 503 })
  }

  const resolved = resolveEmailDomainOrgId(user, validation.data.organization_id)
  if (resolved.notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!resolved.orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })
  const orgId = resolved.orgId

  const db = createServerClient()
  const result = await verifyEmailDomain(db, orgId)

  if (result.notProvisioned) {
    return NextResponse.json(
      { success: false, error: 'No sending domain provisioned yet — start one first.' },
      { status: 409 }
    )
  }
  if (result.error) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 })
  }

  const addonActive = await orgHasEmailDomainAddon(db, orgId)
  return NextResponse.json({
    success: true,
    data: tenantEmailStatePayload(result.row, { addonActive, accountConfigured: true }),
  })
}
