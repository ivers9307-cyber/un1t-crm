// /api/staff/[id]/org-admin — org-admin grants for a staff member
// (SAAS-4, mig 417).
//
//   GET  current org_admin grants for the profile.
//   PUT  desired-state list of organization ids — added orgs are
//        granted, missing orgs are revoked. Sending the same list
//        twice is a no-op (duplicate grants are naturally idempotent
//        under the diff).
//
// MASTER ONLY, both verbs — org-admin is a tenant-shaping grant
// (it hands out owner-everywhere access across a whole org), so like
// the master flag itself it is never delegated to owners or org
// admins. Deliberately NO new WEB_PERMISSIONS key: the gate is the
// master role, same as the is_master toggle this surface sits beside.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

const OrgAdminGrantsSchema = z.object({
  // Desired-state: the FULL set of orgs this profile should be
  // org_admin of after the call. Deduped server-side.
  organization_ids: z.array(uuidLike).max(100),
})

function guardMaster(user) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json(
      { success: false, error: 'Master role required.' },
      { status: 403 }
    )
  }
  return null
}

// GET /api/staff/[id]/org-admin — current grants (master only)
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const guard = guardMaster(user)
  if (guard) return guard

  const db = createServerClient()
  const { data: target } = await db
    .from('profiles')
    .select('id')
    .eq('id', params.id)
    .single()
  if (!target) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: grants, error } = await db
    .from('profile_organizations')
    .select('organization_id, role, created_at')
    .eq('profile_id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    data: { organization_ids: (grants || []).map(g => g.organization_id) },
  })
}

// PUT /api/staff/[id]/org-admin — set the desired grant list (master only)
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const guard = guardMaster(user)
  if (guard) return guard

  const validation = await validateBody(request, OrgAdminGrantsSchema)
  if (!validation.ok) return validation.response
  const desired = Array.from(new Set(validation.data.organization_ids))

  const db = createServerClient()
  const { data: target } = await db
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', params.id)
    .single()
  if (!target) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: existingRows } = await db
    .from('profile_organizations')
    .select('organization_id')
    .eq('profile_id', params.id)
  const existing = new Set((existingRows || []).map(r => r.organization_id))

  const toGrant = desired.filter(orgId => !existing.has(orgId))
  const toRevoke = [...existing].filter(orgId => !desired.includes(orgId))

  if (toGrant.length > 0) {
    // role defaults to 'org_admin' (the only value the CHECK allows).
    const { error } = await db
      .from('profile_organizations')
      .insert(toGrant.map(orgId => ({ profile_id: params.id, organization_id: orgId })))
    if (error) {
      // An unknown org id trips the FK; surface it as a client error
      // rather than a 500 — nothing has been revoked yet at this point.
      return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    }
  }

  if (toRevoke.length > 0) {
    const { error } = await db
      .from('profile_organizations')
      .delete()
      .eq('profile_id', params.id)
      .in('organization_id', toRevoke)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // AUDIT — org-admin is a high-stakes grant (owner-everywhere across
  // an org), logged like master.granted/revoked so it shows in the
  // unified auth log. Audit must never break the response.
  try {
    const actorRef = { id: user.id, full_name: user.full_name, email: user.email }
    const targetRef = {
      id: target.id,
      label: target.full_name,
      resource: `profiles/${target.id}`,
    }
    if (toGrant.length > 0) {
      await logAuditEvent({
        category: 'auth',
        action: 'org_admin.granted',
        actor: actorRef,
        target: targetRef,
        details: { organization_ids: toGrant },
        request,
      })
    }
    if (toRevoke.length > 0) {
      await logAuditEvent({
        category: 'auth',
        action: 'org_admin.revoked',
        actor: actorRef,
        target: targetRef,
        details: { organization_ids: toRevoke },
        request,
      })
    }
  } catch { /* audit must never break the response */ }

  return NextResponse.json({ success: true, data: { organization_ids: desired } })
}
