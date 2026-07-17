// STUDIO-PIN.2 — GET + POST /api/admin/location-trusted-ips
//
// Master-only. Manage the CIDRs that PIN-login accepts as "the
// studio's wifi". A studio typically has one or two entries — the
// main wifi and a backup uplink. Each entry is a CIDR (a /32 single
// host or a /n subnet). DELETE lives in [id]/route.js.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

// Permissive CIDR string match — Postgres's inet type will reject
// anything actually malformed. Strict syntax here would block
// well-formed but rare inputs.
const cidrLike = z.string().min(7).max(64).regex(
  /^[0-9a-fA-F.:]+(\/\d{1,3})?$/,
  'Use a CIDR like 203.0.113.0/24 or 192.168.1.10',
)

export async function GET(request) {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const locationFilter = searchParams.get('location_id')

  const db = createServerClient()
  let query = db
    .from('location_trusted_ips')
    .select('id, location_id, ip_cidr, label, created_at, created_by')
    .order('created_at', { ascending: false })
  if (locationFilter) query = query.eq('location_id', locationFilter)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, ips: data || [] })
}

const AddBody = z.object({
  location_id: uuidLike,
  ip_cidr: cidrLike,
  label: z.string().min(1).max(80).optional(),
})

export async function POST(request) {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const validation = await validateBody(request, AddBody)
  if (!validation.ok) return validation.response
  const { location_id, ip_cidr, label } = validation.data

  const db = createServerClient()
  const { data: row, error } = await db
    .from('location_trusted_ips')
    .insert({
      location_id,
      ip_cidr,
      label: label || null,
      created_by: user.id,
    })
    .select('id, location_id, ip_cidr, label, created_at, created_by')
    .single()
  if (error) {
    // Common case: Postgres rejected the CIDR string as not a valid
    // inet. Surface as 400 with the underlying message.
    const status = /invalid input syntax for type inet/i.test(error.message) ? 400 : 500
    return NextResponse.json({ success: false, error: error.message }, { status })
  }

  await logAuditEvent({
    category: 'business',
    action: 'location_trusted_ip.added',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `location_trusted_ips/${row.id}`, label: label || ip_cidr },
    locationId: location_id,
    details: { ip_cidr, label: label || null },
    request,
  })

  return NextResponse.json({ success: true, ip: row }, { status: 201 })
}
