// SAAS4-P4 — tenant suspend / unsuspend (offboarding step 1; SaaS
// machinery plan §2). Suspension is REVERSIBLE and leverages every
// existing `active = true` filter in one move: flipping the org and
// its locations inactive removes the locations from staff location
// lists (getCurrentUser reads active locations), drops them out of the
// loop-over-locations crons (glofox-sync, data-quality, cap notices),
// and hides them from admin surfaces. The tenant-domains kill switch
// is separate (tenant_domains.active) and deliberately untouched here
// — parking a hostname is its own decision.
//
// POST   /api/admin/orgs/[id]/suspend    → org + its locations inactive
// DELETE /api/admin/orgs/[id]/suspend    → reactivate (unsuspend)
//
// Master-only; both directions audit-logged. Deletion (after the
// settled 60-day retention) stays a manual runbook step — see
// docs/runbooks/tenant-offboarding.md.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function setOrgActive(request, props, active) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: org } = await db
    .from('organizations')
    .select('id, name, active')
    .eq('id', params.id)
    .maybeSingle()
  if (!org) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const { error: orgErr } = await db.from('organizations').update({ active }).eq('id', org.id)
  if (orgErr) return NextResponse.json({ success: false, error: orgErr.message }, { status: 400 })

  const { data: locs, error: locErr } = await db
    .from('locations')
    .update({ active })
    .eq('organization_id', org.id)
    .select('id')
  if (locErr) return NextResponse.json({ success: false, error: locErr.message }, { status: 400 })

  await logAuditEvent({
    category: 'admin',
    action: active ? 'org_unsuspend' : 'org_suspend',
    actor: user,
    target: { resource: `organizations/${org.id}`, label: org.name },
    details: { locations_toggled: (locs || []).length },
    request,
  })

  return NextResponse.json({
    success: true,
    data: { organization_id: org.id, active, locations_toggled: (locs || []).length },
  })
}

export async function POST(request, props) {
  return setOrgActive(request, props, false)
}

export async function DELETE(request, props) {
  return setOrgActive(request, props, true)
}
