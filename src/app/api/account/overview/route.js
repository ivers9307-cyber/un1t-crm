// GET /api/account/overview — Repset ACCOUNT-tier org portfolio roll-up.
//
// REPSET-ACCOUNT.1. Read-only. Owner-of-org + master only.
//
// Org-scoping (service-role route → NO RLS; enforced in app code):
//   - master           may target any org via ?organization_id=, else
//                      defaults to their active org.
//   - owner            is constrained to the orgs they own
//                      (getOwnerOrganizationIds). Requesting a foreign or
//                      unknown org answers 404 — NOT 403 — so another
//                      tenant's existence can't be probed.
//   - manager / staff  (own no org, not master) → 403.
//
// The org is authorised BEFORE any data query runs (resolveAccountScope),
// and every downstream read is filtered to that org's location ids, so no
// other org's studios or data can leak.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  resolveAccountScope,
  fetchOrgLocations,
  assembleAccountHome,
} from '@/lib/account-home'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()

  const { searchParams } = new URL(request.url)
  const scope = resolveAccountScope(user, searchParams.get('organization_id'))
  if (!scope.ok) {
    const errors = {
      401: 'Unauthorized',
      403: 'Account overview is available to owners and master only.',
      404: 'Organisation not found',
    }
    return NextResponse.json(
      { success: false, error: errors[scope.status] || 'Forbidden' },
      { status: scope.status }
    )
  }

  const db = createServerClient()

  // Confirm the org exists (covers a master passing an unknown id) and
  // pull its display name. maybeSingle → null for an unknown id → 404.
  const { data: org } = await db
    .from('organizations')
    .select('id, name, slug')
    .eq('id', scope.orgId)
    .maybeSingle()
  if (!org) {
    return NextResponse.json({ success: false, error: 'Organisation not found' }, { status: 404 })
  }

  const locations = await fetchOrgLocations(db, scope.orgId)
  const data = await assembleAccountHome(db, { organization: org, locations })

  return NextResponse.json({ success: true, data })
}
