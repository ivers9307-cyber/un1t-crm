// GET /api/studio-management/ac/devices
//
//   List the AC devices visible to the caller at the ACTIVE location,
//   filtered by resolveAcAllowlist (AC-ROLE.1): master sees every device;
//   everyone else resolves per-user override → role-template default →
//   code default (manager/owner = all, others = none). Live state is NOT
//   fetched here; that's the per-device /state route. The web control panel
//   (AcControlPanel) and the phone read this.
//
// ACDEVLOC.1 — the POST (add a device) that lived here is gone. It acted on
// the caller's ACTIVE studio, while its only caller, the settings tab, is on
// /settings/locations/<id>. Adding a unit is now
// POST /api/locations/[id]/ac-devices.
//
// Auth: studio_management permission.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { resolveAcAllowlist, filterAcDevices } from '@shared/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---- GET ----

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId }) => {
    const { data: devices, error: devErr } = await db
      .from('ac_devices')
      .select('id, location_id, label, provider, device_group, default_mode, default_temp_c, default_fan, session_minutes, external_auto_off_minutes, enabled, created_at, updated_at')
      .eq('location_id', locationId)
      .eq('enabled', true)
      // Order primarily by group so devices land in their section
      // consecutively when the UI groups by device_group. Label
      // breaks ties inside a group. NULLs sort last in PG ASC
      // ordering, which puts ungrouped devices at the bottom — the
      // panel renders those under a generic 'Other' header.
      .order('device_group', { ascending: true, nullsFirst: false })
      .order('label', { ascending: true })
    if (devErr) {
      return NextResponse.json({ success: false, error: devErr.message }, { status: 500 })
    }

    // AC-ROLE.1 — filter to what the caller may actually control:
    // per-user override → role template → code default (via resolver).
    let visible = devices || []
    if (user.role !== 'master') {
      const { data: pl } = await db
        .from('profile_locations')
        .select('role, ac_device_ids')
        .eq('profile_id', user.id)
        .eq('location_id', locationId)
        .maybeSingle()
      const role = pl?.role || user.profileRole || user.role
      const resolved = resolveAcAllowlist({
        role,
        userList: pl?.ac_device_ids ?? null,
        templateList: user?.acDeviceTemplatesByLocation?.[locationId] ?? null,
      })
      visible = filterAcDevices(resolved, visible)
    }

    return NextResponse.json({ success: true, data: visible })
  }
)
