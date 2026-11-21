// STUDIO-PIN.2 — GET + POST /api/admin/location-trusted-ips
//
// Master-only. Manage the CIDRs that PIN-login accepts as "the
// studio's wifi". A studio typically has one or two entries — the
// main wifi and a backup uplink. Each entry is a CIDR (a /32 single
// host or a /n subnet). DELETE lives in [id]/route.js.
//
// withAuth signs the caller in (a signed-out call is its 401; it was this
// route's 403 'Forbidden' before), then profiles.role master or the same
// 403 'Forbidden'.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody, uuidLike } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isProfileMaster = (user) => user.profileRole === 'master'

// Permissive CIDR string match — Postgres's inet type will reject
// anything actually malformed. Strict syntax here would block
// well-formed but rare inputs.
const cidrLike = z.string().min(7).max(64).regex(
  /^[0-9a-fA-F.:]+(\/\d{1,3})?$/,
  'Use a CIDR like 203.0.113.0/24 or 192.168.1.10',
)

export const GET = withAuth({ permission: null, location: false, allow: isProfileMaster, forbiddenMessage: 'Forbidden' }, async ({ db, request }) => {
  const { searchParams } = new URL(request.url)
  const locationFilter = searchParams.get('location_id')

  let query = db
    .from('location_trusted_ips')
    .select('id, location_id, ip_cidr, label, created_at, created_by')
    .order('created_at', { ascending: false })
  if (locationFilter) query = query.eq('location_id', locationFilter)

  const { data, error } = await query
  if (error) {
    logError('location-trusted-ips', 'list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the trusted networks. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, ips: data || [] })
})

const AddBody = z.object({
  location_id: uuidLike,
  ip_cidr: cidrLike,
  label: z.string().min(1).max(80).optional(),
})

export const POST = withAuth({ permission: null, location: false, allow: isProfileMaster, forbiddenMessage: 'Forbidden' }, async ({ user, db, request }) => {
  const validation = await validateBody(request, AddBody)
  if (!validation.ok) return validation.response
  const { location_id, ip_cidr, label } = validation.data

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
    // inet: a 400 the operator can act on. The database text is logged.
    const badInet = /invalid input syntax for type inet/i.test(error.message)
    logError('location-trusted-ips', 'add failed', { locationId: location_id, err: error })
    return NextResponse.json(
      { success: false, error: badInet ? 'That is not a valid IP address or CIDR.' : 'Could not add the trusted network. Try again.' },
      { status: badInet ? 400 : 500 }
    )
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
})
