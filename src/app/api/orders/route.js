// GET /api/orders
//
// Operator-facing list of orders across all sources (race signups,
// car deposits, future revenue streams). Manager+ at the user's
// active location(s); master sees all locations.
//
// Query params:
//   status        — completed | pending | failed | abandoned | recovered | refunded
//   source_type   — race_registration | car_deposit
//   from / to     — ISO date strings, filters created_at
//   q             — substring match on contact_email or contact_name
//   page / limit  — pagination (default 1 / 50, max 200)
//
// Response shape:
//   { success, data: orders[], counts: {<status>: n}, page, total }
//
// counts is computed server-side so the tab strip can show "Failed (12)"
// without a follow-up call.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_STATUSES = ['completed', 'pending', 'failed', 'abandoned', 'recovered', 'refunded', 'cancelled']
const ALLOWED_SOURCES = ['race_registration', 'car_deposit']

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  // Mig 092 audit: dedicated 'orders' permission key. Honours the
  // location feature gate AND the per-user override.
  if (!hasPermission(user, 'orders')) {
    return NextResponse.json({ success: false, error: 'Orders feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status')
  const sourceParam = url.searchParams.get('source_type')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const q = (url.searchParams.get('q') || '').trim()
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)))

  const db = createServerClient()
  // Scope to the operator's ACTIVE location. The orders page is
  // location-specific by design — when an operator switches the
  // location dropdown the list should follow. Master users without
  // an active location selected fall through to "no scope" (i.e.
  // RLS / policy decides what they see, which is everything).
  const activeLocationId = user.activeLocation?.id || null
  if (!activeLocationId && user.role !== 'master') {
    return NextResponse.json({
      success: true,
      data: [],
      counts: Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0])),
      page, limit, total: 0,
    })
  }

  // Counts query: same filters except status, grouped client-side.
  const countQuery = db
    .from('orders')
    .select('status', { count: 'exact' })
  if (activeLocationId) countQuery.eq('location_id', activeLocationId)
  if (sourceParam && ALLOWED_SOURCES.includes(sourceParam)) countQuery.eq('source_type', sourceParam)
  if (from) countQuery.gte('created_at', from)
  if (to) countQuery.lte('created_at', to)
  if (q) countQuery.or(`contact_email.ilike.%${q}%,contact_name.ilike.%${q}%`)

  // Run counts per-status as a small batch — Supabase JS doesn't
  // support GROUP BY directly. Five queries is cheap and the result
  // shape is dead simple.
  const counts = {}
  await Promise.all(ALLOWED_STATUSES.map(async (s) => {
    let q2 = db.from('orders').select('id', { count: 'exact', head: true }).eq('status', s)
    if (activeLocationId) q2 = q2.eq('location_id', activeLocationId)
    if (sourceParam && ALLOWED_SOURCES.includes(sourceParam)) q2 = q2.eq('source_type', sourceParam)
    if (from) q2 = q2.gte('created_at', from)
    if (to) q2 = q2.lte('created_at', to)
    if (q) q2 = q2.or(`contact_email.ilike.%${q}%,contact_name.ilike.%${q}%`)
    const { count } = await q2
    counts[s] = count || 0
  }))

  // Main listing.
  let listQ = db
    .from('orders')
    .select(`
      id, location_id, organization_id,
      source_type, source_id,
      contact_id, contact_email, contact_phone, contact_name,
      amount_cents, currency, status,
      payment_provider, payment_provider_ref,
      retry_of_order_id, superseded_by_order_id,
      created_at, completed_at, failed_at, abandoned_at, refunded_at,
      metadata
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (activeLocationId) listQ = listQ.eq('location_id', activeLocationId)
  if (statusParam && ALLOWED_STATUSES.includes(statusParam)) listQ = listQ.eq('status', statusParam)
  if (sourceParam && ALLOWED_SOURCES.includes(sourceParam)) listQ = listQ.eq('source_type', sourceParam)
  if (from) listQ = listQ.gte('created_at', from)
  if (to) listQ = listQ.lte('created_at', to)
  if (q) listQ = listQ.or(`contact_email.ilike.%${q}%,contact_name.ilike.%${q}%`)

  const { data, error, count: total } = await listQ
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: data || [],
    counts,
    page,
    limit,
    total: total || 0,
  })
}
