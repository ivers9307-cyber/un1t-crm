// STUDIO-PIN.2 — DELETE /api/admin/studio-devices/[id]
//
// Master-only. Sets `revoked_at = now()` on the device — soft delete
// so the audit trail in pin_login_attempts still resolves the
// device's label / location. Once revoked, the next PIN-login
// attempt using that device's token logs `revoked_device` and 403s.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: existing } = await db
    .from('studio_devices')
    .select('id, location_id, label, device_kind, revoked_at')
    .eq('id', params.id)
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
    .eq('id', params.id)
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  }

  await logAuditEvent({
    category: 'business',
    action: 'studio_device.revoked',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: existing.id, resource: `studio_devices/${existing.id}`, label: existing.label },
    locationId: existing.location_id,
    details: { device_kind: existing.device_kind, label: existing.label },
    request,
  })

  return NextResponse.json({ success: true })
}
