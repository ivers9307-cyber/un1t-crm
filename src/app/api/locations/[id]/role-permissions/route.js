// PERM-AUDIT.2 — operator-editable role permission templates.
//
// GET  /api/locations/[id]/role-permissions
//        → { role: { template, effective } } for the four
//          templatable roles. `template` is the stored sparse diff
//          (mig 364); `effective` is the full hydrated blob the
//          editor renders (code defaults + template).
// PUT  /api/locations/[id]/role-permissions
//        Body: { role, permissions } where `permissions` is the FULL
//        desired effective blob for that role. The server sanitises
//        it, diffs it against the code defaults and stores only the
//        sparse difference — an all-defaults save deletes the row.
//
// Access: master, or owner AT THIS location. Editing what a role
// means at your studio is an owner decision (unlike the per-location
// feature matrix, which stayed master-only per the Nov 2026 audit —
// features kill a surface for everyone; templates only re-shape
// role defaults, and per-user overrides still win).
//
// 'master' is not templatable — the resolver short-circuits master
// past the template tier, so a row could never take effect.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  hydratePermissions,
  sanitizePermissionsBlob,
  diffPermissionsBlob,
} from '@shared/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEMPLATABLE_ROLES = ['owner', 'manager', 'head_coach', 'staff']

function canEditRoleTemplates(user, locationId) {
  if (user.role === 'master' || user.profileRole === 'master') return true
  return user.rolesByLocation?.[locationId] === 'owner'
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditRoleTemplates(user, params.id)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: rows, error } = await db
    .from('location_role_permissions')
    .select('role, permissions, updated_at')
    .eq('location_id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const byRole = {}
  for (const role of TEMPLATABLE_ROLES) {
    const row = (rows || []).find((r) => r.role === role)
    const template = row?.permissions || {}
    byRole[role] = {
      template,
      effective: hydratePermissions(null, role, template),
      updated_at: row?.updated_at || null,
    }
  }
  return NextResponse.json({ success: true, data: byRole })
}

const Body = z.object({
  role: z.enum(TEMPLATABLE_ROLES),
  permissions: z.record(z.string(), z.unknown()),
})

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditRoleTemplates(user, params.id)) {
    return NextResponse.json({
      success: false,
      error: 'Only a master or an owner at this location can edit role permissions.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { role, permissions } = validation.data

  // Sanitise (whitelist keys / boolean values) then reduce the full
  // desired blob to a sparse diff vs the code defaults. Extras
  // (layout, lead_time_overrides) are per-user, never role-level.
  const desired = sanitizePermissionsBlob(permissions)
  const sparse = diffPermissionsBlob(
    desired,
    hydratePermissions(null, role),
    { includeExtras: false }
  )

  const db = createServerClient()
  const isEmpty = Object.keys(sparse).length === 0
  if (isEmpty) {
    // All values match the code defaults → no row needed. Delete so
    // the role goes back to pure code-default inheritance.
    const { error } = await db
      .from('location_role_permissions')
      .delete()
      .eq('location_id', params.id)
      .eq('role', role)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, data: { role, template: {}, effective: hydratePermissions(null, role) } })
  }

  const { data, error } = await db
    .from('location_role_permissions')
    .upsert({
      location_id: params.id,
      role,
      permissions: sparse,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,role' })
    .select('role, permissions')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({
    success: true,
    data: {
      role: data.role,
      template: data.permissions,
      effective: hydratePermissions(null, role, data.permissions),
    },
  })
}
