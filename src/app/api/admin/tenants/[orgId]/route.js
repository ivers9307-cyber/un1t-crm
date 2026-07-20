// GET /api/admin/tenants/[orgId] — master-only tenant drill-in
// (INTEG-D2): org header + per-location blocks (pinned plan, wallet +
// last-50 ledger, MTD meters vs allowance + exempt assistant line,
// integrations summary, stale heartbeats). Pure read; assembly lives
// in src/lib/admin-tenants.js.
//
// Detail route → 404 (not 403) for unknown/malformed ids so org ids
// can't be enumerated. Master role only.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/validate'
import { getTenantDetail } from '@/lib/admin-tenants'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  // Malformed id = not found (never a Postgres cast error).
  if (!uuidLike.safeParse(params.orgId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()
  try {
    const data = await getTenantDetail(db, params.orgId)
    if (!data) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
