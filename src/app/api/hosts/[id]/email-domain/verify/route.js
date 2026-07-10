// POST /api/hosts/[id]/email-domain/verify
//
// Re-check a host's sending-domain DNS with Postmark and stamp
// event_hosts.sender_domain_verified (HOST-EMAIL.2). Manager+ (ADMIN_ROLES),
// org-scoped — cross-org ids 404 via loadHostForOrg.
//
// Two modes:
//   • default (empty body) — ask Postmark to re-verify DKIM + Return-Path,
//     then read the domain and set sender_domain_verified to
//     (DKIMVerified && ReturnPathDomainVerified). The verify calls are
//     best-effort (Postmark rejects them while DNS is still wrong); the
//     getDomain read is the source of truth for the flags we persist.
//   • { verified: false } — the per-host KILL SWITCH: force-unverify with no
//     Postmark call. An unverified host cannot send (PR-C gates on the flag).
//
// Response data mirrors the provisioning route: { domain, sender_email,
// sender_name, slug, verified, dkim_verified, return_path_verified, records }.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { HOST_COLS, loadHostForOrg } from '@/lib/hosts'
import { getDomain, verifyDkim, verifyReturnPath, dnsRecordsFrom, domainIsFullyVerified } from '@/lib/postmark-domains'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  // Only `false` is meaningful — verified:true comes from Postmark, never
  // from the client.
  verified: z.literal(false).optional(),
})

function domainStatePayload(hostRow, domain) {
  return {
    domain: hostRow.sender_domain,
    sender_email: hostRow.sender_email,
    sender_name: hostRow.sender_name,
    slug: hostRow.slug,
    verified: !!hostRow.sender_domain_verified,
    dkim_verified: !!domain?.DKIMVerified,
    return_path_verified: !!domain?.ReturnPathDomainVerified,
    records: dnsRecordsFrom(domain),
  }
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  // Body optional — empty body = normal verification pass.
  let raw = {}
  try { raw = await request.json() } catch { /* no JSON body */ }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 })
  }

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  // ── Kill switch: force-unverify, no Postmark round-trip ──────────
  if (parsed.data.verified === false) {
    const { data: updated, error } = await db
      .from('event_hosts')
      .update({ sender_domain_verified: false })
      .eq('id', host.id)
      .select(HOST_COLS)
      .single()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: domainStatePayload(updated, null) })
  }

  if (!host.postmark_domain_id) {
    return NextResponse.json({
      success: false,
      error: 'No sending domain provisioned yet — provision one first.',
    }, { status: 409 })
  }

  // Ask Postmark to re-check both records. Best-effort: while the DNS is
  // still missing/wrong Postmark answers these with an error — the state
  // read below is what decides the flag either way.
  try { await verifyDkim(host.postmark_domain_id) } catch (e) {
    logWarn('host-email-domain', 'verifyDkim rejected', { err: e })
  }
  try { await verifyReturnPath(host.postmark_domain_id) } catch (e) {
    logWarn('host-email-domain', 'verifyReturnPath rejected', { err: e })
  }

  let domain
  try {
    domain = await getDomain(host.postmark_domain_id)
  } catch (e) {
    logError('host-email-domain', 'getDomain failed during verify', { err: e })
    return NextResponse.json({ success: false, error: e.message || 'Could not read the sending domain.' }, { status: 502 })
  }

  const verified = domainIsFullyVerified(domain)
  const { data: updated, error: updateErr } = await db
    .from('event_hosts')
    .update({ sender_domain_verified: verified })
    .eq('id', host.id)
    .select(HOST_COLS)
    .single()
  if (updateErr) {
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: domainStatePayload(updated, domain) })
}
