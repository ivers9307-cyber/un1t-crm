// CONSENT.3 — Consent history feed for the contact profile card.
//
// GET /api/contacts/[id]/consent-log
//   Returns every consent_log row for the contact, joined to
//   profiles so we can show "performed by" as a name instead of a
//   UUID. Append-only audit table — no PATCH/DELETE on this route.
//
// Access (H1, 2026-06 platform audit): this route uses
// createServerClient() (service role) which BYPASSES RLS — the
// location-scoped policy on consent_log only binds the `authenticated`
// role, so it does NOT filter this query. We resolve the contact's
// location_id and gate with assertLocationAccess(); without it any
// authenticated user could read any contact's consent history (incl.
// ip_address) by enumerating contact IDs.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Hard cap. A contact would have to bounce in/out of consent on
// every channel daily for a year+ to hit this; if we ever do, the
// page will stop loading new entries past it and the operator can
// query directly.
const MAX_ROWS = 500

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // Resolve the contact's location and gate on it before returning any
  // consent rows (H1). A non-existent contact and a contact in another
  // tenant both look the same to the caller (404 / 403 respectively).
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  // Pull the rows + the acting profile name in one round-trip.
  // performed_by may be null (self-service preference centre, the
  // ClassPass auto-trigger, etc) — handle that in the UI rather
  // than filter here.
  const { data, error } = await db
    .from('consent_log')
    .select('id, created_at, channel, action, source, ip_address, performed_by, profiles:performed_by(full_name, email)')
    .eq('contact_id', params.id)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Flatten the joined profile so the client doesn't have to walk
  // the nested object. profiles is a single row when the join's
  // 1:1 column is set; falls back to null for self-service rows.
  const rows = (data || []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    channel: r.channel,
    action: r.action,
    source: r.source,
    ip_address: r.ip_address,
    performed_by_name:  r.profiles?.full_name || null,
    performed_by_email: r.profiles?.email || null,
  }))

  return NextResponse.json({
    success: true,
    rows,
    truncated: rows.length === MAX_ROWS,
  })
}
