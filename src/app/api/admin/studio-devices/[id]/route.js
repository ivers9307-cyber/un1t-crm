// STUDIO-PIN.2 — DELETE /api/admin/studio-devices/[id]
//
// Master-only. Sets `revoked_at = now()` on the device — soft delete
// so the audit trail in pin_login_attempts still resolves the
// device's label / location. Once revoked, the next PIN-login
// attempt using that device's token logs `revoked_device` and 403s.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in (a signed-out call now answers its 401);
// masters only (profiles.role), refused with the same 403 'Forbidden', here.
export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data: existing } = await db
    .from('studio_devices')
    .select('id, location_id, label, device_kind, revoked_at')
    .eq('id', params?.id)
    .single()
  if (!existing) {
    return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
  }
  if (existing.revoked_at) {
    return NextResponse.json({ success: true, already_revoked: true })
  }

  const { error: updErr } = await db
    .from('studio_devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', params?.id)
  if (updErr) {
    logError('studio-pin', 'device revoke failed', { err: updErr, id: existing.id })
    return NextResponse.json({ success: false, error: 'Could not revoke the device.' }, { status: 500 })
  }

  await logAuditEvent({
    category: 'business',
    action: 'studio_device.revoked',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `studio_devices/${existing.id}`, label: existing.label },
    locationId: existing.location_id,
    details: { device_kind: existing.device_kind, label: existing.label },
    request,
  })

  return NextResponse.json({ success: true })
})
