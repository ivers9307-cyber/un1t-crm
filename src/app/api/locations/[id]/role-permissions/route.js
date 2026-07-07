// PERM-AUDIT.2 — operator-editable role permission templates.
//
// GET  /api/locations/[id]/role-permissions
//        → { role: { template, effective } } for the four
//          templatable roles. `template` is the stored sparse diff
//          (mig 364); `effective` is the full hydrated blob the
//          editor renders (code defaults + template).
// PUT  /api/locations/[id]/role-permissions
//        Body: { role, permissions, ac_device_ids? } where `permissions`
//        is the FULL desired effective blob for that role. The server
//        sanitises it, diffs it against the code defaults and stores
//        only the sparse difference — an all-defaults save with no AC
//        override deletes the row. `ac_device_ids` (mig 379) is the
//        role-level AC device allowlist default, stored ABSOLUTE (not
//        diffed): null = inherit, [] = explicit none, [ids] = those.
//        Omitting the key preserves whatever is already stored.
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
import { uuidLike } from '@/lib/schemas'
import {
  hydratePermissions,
  sanitizePermissionsBlob,
  diffPermissionsBlob,
  mergeTemplates,
} from '@shared/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEMPLATABLE_ROLES = ['owner', 'manager', 'head_coach', 'staff', 'reception']
const EMPLOYMENT_VARIANTS = ['fte', 'contractor', 'casual']

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
    .select('role, employment_type, permissions, ac_device_ids, updated_at')
    .eq('location_id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // RECEPTION.2 (mig 367) — each role carries an 'all' template
  // (backward-compatible top-level shape) plus employment-type
  // variants that layer on top of it. A variant's `effective` blob
  // is code defaults + 'all' + variant — exactly what the resolver
  // uses for a user of that employment type.
  const byRole = {}
  for (const role of TEMPLATABLE_ROLES) {
    const rowFor = (emp) => (rows || []).find((r) => r.role === role && r.employment_type === emp)
    const allRow = rowFor('all')
    const allTemplate = allRow?.permissions || {}
    const variants = {}
    for (const emp of EMPLOYMENT_VARIANTS) {
      const row = rowFor(emp)
      const template = row?.permissions || {}
      variants[emp] = {
        template,
        effective: hydratePermissions(null, role, mergeTemplates(allTemplate, template)),
        updated_at: row?.updated_at || null,
        ac_device_ids: row?.ac_device_ids ?? null,
      }
    }
    byRole[role] = {
      template: allTemplate,
      effective: hydratePermissions(null, role, allTemplate),
      updated_at: allRow?.updated_at || null,
      variants,
      ac_device_ids: allRow?.ac_device_ids ?? null,
    }
  }
  return NextResponse.json({ success: true, data: byRole })
}

const Body = z.object({
  role: z.enum(TEMPLATABLE_ROLES),
  // 'all' edits the role's base template; an employment type edits
  // the variant that layers on top of it (RECEPTION.2, mig 367).
  employment_type: z.enum(['all', ...EMPLOYMENT_VARIANTS]).default('all'),
  permissions: z.record(z.string(), z.unknown()),
  // AC-ROLE.1 — role-level AC device allowlist default (mig 379).
  // null = inherit, [] = explicit none, [ids] = those devices.
  ac_device_ids: z.array(uuidLike).nullable().optional(),
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
  const { role, employment_type: employmentType, permissions } = validation.data

  const db = createServerClient()

  // The diff base depends on what's being edited (RECEPTION.2):
  //   'all'    → code defaults (the base template stores its diff
  //              against them, as before);
  //   variant  → code defaults + the CURRENT 'all' template, so a
  //              variant row stores only what differs from what a
  //              user of that role already inherits.
  let baseTemplate = null
  if (employmentType !== 'all') {
    try {
      const { data: allRow } = await db
        .from('location_role_permissions')
        .select('permissions')
        .eq('location_id', params.id)
        .eq('role', role)
        .eq('employment_type', 'all')
        .maybeSingle()
      baseTemplate = allRow?.permissions || null
    } catch {
      baseTemplate = null
    }
  }

  // Sanitise (whitelist keys / boolean values) then reduce the full
  // desired blob to a sparse diff vs the base. Extras (layout,
  // lead_time_overrides) are per-user, never role-level.
  const desired = sanitizePermissionsBlob(permissions)
  const sparse = diffPermissionsBlob(
    desired,
    hydratePermissions(null, role, baseTemplate),
    { includeExtras: false }
  )

  // AC-ROLE.1 — the role-level AC device allowlist for this slice is
  // stored ABSOLUTE (null = inherit, [] = none, [ids] = those), NOT
  // diffed. If the caller omitted the key, preserve the existing value.
  let acDeviceIds = validation.data.ac_device_ids
  if (acDeviceIds === undefined) {
    const { data: existingAc } = await db
      .from('location_role_permissions')
      .select('ac_device_ids')
      .eq('location_id', params.id)
      .eq('role', role)
      .eq('employment_type', employmentType)
      .maybeSingle()
    acDeviceIds = existingAc?.ac_device_ids ?? null
  }

  const respond = (template, acIds) => NextResponse.json({
    success: true,
    data: {
      role,
      employment_type: employmentType,
      template,
      ac_device_ids: acIds ?? null,
      effective: hydratePermissions(null, role, mergeTemplates(baseTemplate, template)),
    },
  })

  const isEmpty = Object.keys(sparse).length === 0 && acDeviceIds === null
  if (isEmpty) {
    // All values match the base and no AC override → no row needed.
    // Delete so this slice goes back to pure inheritance.
    const { error } = await db
      .from('location_role_permissions')
      .delete()
      .eq('location_id', params.id)
      .eq('role', role)
      .eq('employment_type', employmentType)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return respond({}, null)
  }

  const { data, error } = await db
    .from('location_role_permissions')
    .upsert({
      location_id: params.id,
      role,
      employment_type: employmentType,
      permissions: sparse,
      ac_device_ids: acDeviceIds,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,role,employment_type' })
    .select('role, permissions, ac_device_ids')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return respond(data.permissions, data.ac_device_ids)
}
