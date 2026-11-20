// INTEG-B3 — POST /api/settings/email-domain/verify
//
// Trigger a Postmark re-check of the org's sending domain (DKIM +
// Return-Path); when both verify, flip status → 'live'. IDEMPOTENT.
//
// Access: an organisation admin (same gate as the parent route, C18 ORGROLE.1). Operates
// on an ALREADY-provisioned row (409 if none) — the add-on gate lives on
// the initiate route; a provisioned domain stays verifiable so a live org
// can re-confirm DNS. 503 when POSTMARK_ACCOUNT_TOKEN is unset. The server
// token is never returned (redacted status payload).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { isOrgAdminSomewhere } from '@/lib/org-admin'
import { validateBody, uuidLike } from '@/lib/validate'
import { isPostmarkAccountConfigured } from '@/lib/postmark-account'
import { orgHasEmailDomainAddon, tenantEmailStatePayload } from '@/lib/tenant-email'
import { resolveEmailDomainOrgId, verifyEmailDomain } from '@/lib/email-domain-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VerifySchema = z.object({
  organization_id: uuidLike.optional(),
})

// withAuth only signs the caller in; the organisation-admin checks run here.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Organisation admin role required.' }, { status: 403 })
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

  const result = await verifyEmailDomain(db, orgId)

  // CHANNELREAD.1 — our own read of the stored state failed: nothing was
  // checked, and it is not "not provisioned".
  if (result.readFailed) {
    return NextResponse.json(
      { success: false, error: 'Could not read the sending domain just now, so nothing was checked. Try again.' },
      { status: 500 }
    )
  }

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
})
