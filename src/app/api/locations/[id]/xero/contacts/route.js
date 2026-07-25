// XERO-API.2 PR 2 — GET /api/locations/[id]/xero/contacts
//
// Read-side endpoint for the ContactPicker (supplier autocomplete)
// in /invoices review. Returns rows from the local xero_contacts
// cache (PR 1).
//
// Query params:
//   ?q=<search>        — case-insensitive substring on name OR email.
//                        2+ chars required for the search to actually
//                        run; shorter queries return [] (the picker
//                        renders a "keep typing…" hint).
//   ?suppliers=1       — filter is_supplier=true (the default for
//                        /invoices). Omit to search all contacts.
//   ?limit=25          — clamp on max rows returned (default 25, cap 100).
//
// Always filters status='ACTIVE'. Archived contacts stay cached for
// historical-label resolution but aren't surfaced in the picker.
//
// Returns: { success, contacts: [{ id, xero_contact_id, name, email, is_supplier }], stale }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { serverErrorResponse } from '@/lib/error-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 30
const MIN_QUERY_LENGTH = 2

export async function GET(request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') || '').trim()
  const suppliersOnly = url.searchParams.get('suppliers') === '1'
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100)

  const db = createServerClient()

  // Connection freshness — same posture as accounts endpoint.
  const { data: conn } = await db
    .from('xero_connections')
    .select('contacts_last_synced_at')
    .eq('location_id', locationId)
    .maybeSingle()
  const stale = !conn?.contacts_last_synced_at
    || (Date.now() - new Date(conn.contacts_last_synced_at).getTime()) > STALE_AFTER_DAYS * 86400_000

  // Below the min query length → return empty payload (still
  // signalling stale state so the UI can show a hint).
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({
      success: true,
      contacts: [],
      lastSyncedAt: conn?.contacts_last_synced_at || null,
      stale,
      hint: `Type at least ${MIN_QUERY_LENGTH} characters to search.`,
    })
  }

  let builder = db
    .from('xero_contacts')
    .select('id, xero_contact_id, name, email, is_supplier')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')

  if (suppliersOnly) builder = builder.eq('is_supplier', true)

  // ILIKE on name OR email. PostgREST's `or` filter takes a comma-
  // separated list of conditions. Escape % / , in the user query so
  // they're treated as literal.
  const safe = q.replace(/[%_,]/g, (c) => `\\${c}`)
  builder = builder.or(`name.ilike.%${safe}%,email.ilike.%${safe}%`)

  const { data: contacts, error } = await builder
    .order('name', { ascending: true })
    .limit(limit)

  if (error) {
    // OBS-HANDLED.1 — same body/status as before, plus log + error_events.
    return serverErrorResponse({ module: 'xero-contacts', error, request })
  }

  return NextResponse.json({
    success: true,
    contacts: contacts || [],
    lastSyncedAt: conn?.contacts_last_synced_at || null,
    stale,
  })
}
