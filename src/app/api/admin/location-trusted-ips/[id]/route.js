// STUDIO-PIN.2 — DELETE /api/admin/location-trusted-ips/[id]
//
// Master-only. Hard delete — the CIDR list is small enough that we
// don't need soft-delete semantics. Audit log records the removal.

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

  // Read first so we can audit the removed row's CIDR / label.
  const { data: existing } = await db
    .from('location_trusted_ips')
    .select('id, location_id, ip_cidr, label')
    .eq('id', params.id)
    .single()
  if (!existing) {
    return NextResponse.json({ success: false, error: 'Trusted IP not found' }, { status: 404 })
  }

  const { error } = await db
    .from('location_trusted_ips')
    .delete()
    .eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  await logAuditEvent({
    category: 'business',
    action: 'location_trusted_ip.removed',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: existing.id, resource: `location_trusted_ips/${existing.id}`, label: existing.label || existing.ip_cidr },
    locationId: existing.location_id,
    details: { ip_cidr: existing.ip_cidr, label: existing.label || null },
    request,
  })

  return NextResponse.json({ success: true })
}
