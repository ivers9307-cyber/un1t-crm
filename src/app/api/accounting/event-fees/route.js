// src/app/api/accounting/event-fees/route.js
//
// HOST-PORTAL.8 — org-wide event booking fees for /accounting. The
// per-ticket application fee UN1T kept across ALL of the org's event
// hosts (race_payments.application_fee_cents, settled rows only).
// C18 ORGROLE.1 (Richard, 1 Oct 2026): an org-wide report, so an
// ORGANISATION ADMIN of the active org (master or an org_admin grant) — not
// the `accounting_hub` permission at the active studio, which a studio owner
// or a granted manager holds without being an organisation admin.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { activeOrganizationId, isOrgAdmin } from '@/lib/org-admin'
import { getOrgEventFees } from '@/lib/org-event-fees'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The admin check runs before the "no active organisation" 400, as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => isOrgAdmin(user, activeOrganizationId(user)), forbiddenMessage: 'Forbidden' },
  async ({ user, db }) => {
    const orgId = activeOrganizationId(user)
    if (!orgId) {
      return NextResponse.json({ success: false, error: 'No active organization' }, { status: 400 })
    }
    const data = await getOrgEventFees(db, orgId)
    return NextResponse.json({ success: true, data })
  },
)
