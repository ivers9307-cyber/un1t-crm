// src/app/api/accounting/event-fees/route.js
//
// HOST-PORTAL.8 — org-wide event booking fees for /accounting. The
// per-ticket application fee UN1T kept across ALL of the org's event
// hosts (race_payments.application_fee_cents, settled rows only).
// Guards mirror the accounting siblings (payables/coverage/mailboxes):
// session -> accounting_hub permission -> session org.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getOrgEventFees } from '@/lib/org-event-fees'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) {
    return NextResponse.json({ success: false, error: 'No active organization' }, { status: 400 })
  }

  const db = createServerClient()
  const data = await getOrgEventFees(db, orgId)
  return NextResponse.json({ success: true, data })
}
