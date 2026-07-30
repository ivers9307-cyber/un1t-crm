// POST /api/hosts/[id]/email-domain
//
// Provision (or re-read) a host's dedicated sending domain via the Postmark
// Domains API (HOST-EMAIL.2). Manager+ (ADMIN_ROLES), org-scoped — cross-org
// ids 404 via loadHostForOrg, mirroring /api/hosts/[id]/invite.
//
// Body (optional): { label?, sender_name? }. The domain is always
// <label>.mail.un1tdublin.com — label sanitized to [a-z0-9-], defaulting to
// the host's name. First call creates the Postmark domain and persists
// postmark_domain_id / sender_domain / sender_email (hello@<domain>) /
// sender_name (default: host name), and derives event_hosts.slug if still
// null (the public /h/[slug] mailing-list page needs it). Subsequent calls
// are IDEMPOTENT: with postmark_domain_id already set we only re-read the
// domain from Postmark and return its current state — no second domain is
// ever created, whatever label is posted.
//
// Response data: { domain, sender_email, sender_name, slug, verified,
// dkim_verified, return_path_verified, records } — records are the DNS
// entries (DKIM TXT + Return-Path CNAME) the operator adds to the
// un1tdublin.com zone. Verification itself happens on the sibling
// /email-domain/verify route.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { HOST_COLS, loadHostForOrg, ensureHostSlug } from '@/lib/hosts'
import {
  createDomain,
  getDomain,
  dnsRecordsFrom,
  sanitizeDomainLabel,
} from '@/lib/postmark-domains'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Every host sending domain lives under this parent zone. DNS label limit
// is 63 chars — cap the operator's input accordingly.
const SENDER_DOMAIN_PARENT = 'mail.un1tdublin.com'

const BodySchema = z.object({
  label: z.string().trim().max(63).optional(),
  sender_name: z.string().trim().min(1).max(200).optional(),
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

  // Body is optional — an empty POST provisions with all defaults.
  let raw = {}
  try { raw = await request.json() } catch { /* no JSON body — defaults */ }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid label or sender name.' }, { status: 400 })
  }
  const body = parsed.data || {}

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  // ── Already provisioned → idempotent re-read ─────────────────────
  if (host.postmark_domain_id) {
    // Self-heal a missing slug (e.g. provisioned before a failed derivation).
    try {
      host.slug = await ensureHostSlug(db, host)
    } catch (e) {
      logError('host-email-domain', 'slug self-heal failed', { err: e })
    }
    try {
      const domain = await getDomain(host.postmark_domain_id)
      return NextResponse.json({ success: true, data: domainStatePayload(host, domain) })
    } catch (e) {
      logError('host-email-domain', 'getDomain failed', { err: e })
      return NextResponse.json({ success: false, error: e.message || 'Could not read the sending domain.' }, { status: 502 })
    }
  }

  // ── First provision ──────────────────────────────────────────────
  const label = sanitizeDomainLabel(body.label) || sanitizeDomainLabel(host.name)
  if (!label) {
    return NextResponse.json({
      success: false,
      error: 'Enter a subdomain label (letters, numbers and dashes).',
    }, { status: 400 })
  }
  const domainName = `${label}.${SENDER_DOMAIN_PARENT}`

  let domain
  try {
    domain = await createDomain(domainName)
  } catch (e) {
    logError('host-email-domain', 'createDomain failed', { err: e })
    return NextResponse.json({ success: false, error: e.message || 'Could not create the sending domain.' }, { status: 502 })
  }
  if (!domain?.ID) {
    logError('host-email-domain', 'createDomain returned no ID', { domain })
    return NextResponse.json({ success: false, error: 'Postmark did not return a domain id.' }, { status: 502 })
  }

  const { data: updated, error: updateErr } = await db
    .from('event_hosts')
    .update({
      postmark_domain_id: domain.ID,
      sender_domain: domainName,
      sender_email: `hello@${domainName}`,
      sender_name: body.sender_name || host.sender_name || host.name,
    })
    .eq('id', host.id)
    .select(HOST_COLS)
    .single()
  if (updateErr) {
    // The Postmark domain exists but our row didn't take it — surfacing the
    // error lets the operator retry; the retry lands on createDomain again,
    // where Postmark's "already exists" message points at the mismatch.
    logError('host-email-domain', 'sender columns persist failed', { err: updateErr })
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  try {
    updated.slug = await ensureHostSlug(db, updated)
  } catch (e) {
    // Non-fatal: the domain is provisioned; the slug self-heals on the next
    // idempotent call. The signup page just isn't linkable yet.
    logError('host-email-domain', 'slug derivation failed', { err: e })
  }

  return NextResponse.json({ success: true, data: domainStatePayload(updated, domain) })
}
