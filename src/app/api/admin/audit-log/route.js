// GET /api/admin/audit-log — Master/owner-only paginated read of
// audit_events with filters.
//
// AUDIT-EXPAND.1: this used to read from assignment_change_log
// directly. It now reads from the unified audit_events table
// introduced in migration 180, which covers auth + business +
// assignment + mutation events. The legacy assignment_change_log
// is still being WRITTEN to (in parallel) during the transition
// cycle, but the UI reads from audit_events exclusively.
//
// Query params:
//   actor_id?           Filter by who performed the change.
//   target_profile_id?  Filter by who was affected.
//   location_id?        Filter to a specific location.
//   category?           One of 'auth' | 'business' | 'mutation'
//                       | 'assignment'. Filter to a top-level
//                       category of event.
//   action?             Filter to an exact action key
//                       (e.g. 'contract.issued', 'auth.sign_in',
//                       'assignment.assignment_create').
//   from?               ISO 8601 — only entries at or after.
//   to?                 ISO 8601 — only entries at or before.
//   page?               1-indexed (default 1).
//   page_size?          Default 50, max 200.
//   format?             'json' (default) or 'csv'. csv triggers a
//                       file download with Content-Disposition.
//
// Joins actor + target full_name/email so the UI doesn't need a
// secondary lookup. Locations joined for name display.
//
// Returns:
//   { success: true, data: [...rows], page, page_size, total }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CATEGORIES = ['auth', 'business', 'mutation', 'assignment']

const QuerySchema = z.object({
  actor_id: uuidLike.optional(),
  target_profile_id: uuidLike.optional(),
  location_id: uuidLike.optional(),
  category: z.enum(CATEGORIES).optional(),
  action: z.string().min(1).max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
  format: z.enum(['json', 'csv']).default('json'),
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // RLS allows master + owner SELECT. The page itself is master-only
  // (admin layout), but allow owner via API so future per-location
  // audit pages don't need a separate route.
  if (user.profileRole !== 'master' && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const params = Object.fromEntries(url.searchParams.entries())
  const parsed = QuerySchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: 'Invalid query',
      issues: parsed.error.issues,
    }, { status: 400 })
  }
  const q = parsed.data

  const db = createServerClient()

  // Service-role client bypasses RLS, so the mig 106-style "owner sees
  // their org" scoping has to live in app code. Non-master callers are
  // constrained to the audit events at their own assigned locations; a
  // caller with no locations sees nothing (don't run an unscoped query).
  const isMaster = user.profileRole === 'master'
  const scopeLocationIds = isMaster ? null : getUserLocationIds(user)
  if (!isMaster && scopeLocationIds.length === 0) {
    return NextResponse.json({
      success: true,
      data: [],
      page: q.page,
      page_size: q.page_size,
      total: 0,
      facets: q.page === 1 && q.format !== 'csv'
        ? { categories: CATEGORIES, actions: [] }
        : null,
    })
  }

  // Build the query. Foreign-key joins via PostgREST embed syntax.
  // actor_id and target_profile_id both reference profiles; the
  // explicit FK aliases avoid ambiguity. target_label /
  // actor_label are persisted on the row at write-time so we still
  // have something to show after a profile is deleted (FK is ON
  // DELETE SET NULL).
  let query = db
    .from('audit_events')
    .select(`
      id, occurred_at, category, action,
      actor_label, target_label, target_resource,
      details, ip_address, user_agent,
      actor:actor_id ( id, full_name, email ),
      target:target_profile_id ( id, full_name, email ),
      location:location_id ( id, name )
    `, { count: 'exact' })
    .order('occurred_at', { ascending: false })

  // Non-master: hard-scope to the caller's locations (service-role has no RLS).
  if (scopeLocationIds) query = query.in('location_id', scopeLocationIds)

  if (q.actor_id) query = query.eq('actor_id', q.actor_id)
  if (q.target_profile_id) query = query.eq('target_profile_id', q.target_profile_id)
  if (q.location_id) query = query.eq('location_id', q.location_id)
  if (q.category) query = query.eq('category', q.category)
  if (q.action) query = query.eq('action', q.action)
  if (q.from) query = query.gte('occurred_at', q.from)
  if (q.to) query = query.lte('occurred_at', q.to)

  // CSV export bypasses pagination — returns the full filtered set
  // up to a hard cap to avoid OOM. 5000 is plenty for any reasonable
  // human-driven export; cron-driven exports can paginate themselves.
  const isCsv = q.format === 'csv'
  if (isCsv) {
    query = query.range(0, 4999)
  } else {
    const from = (q.page - 1) * q.page_size
    query = query.range(from, from + q.page_size - 1)
  }

  const { data, count, error } = await query
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // For the UI's category/action picker dropdowns we surface the
  // full known-action set in a single call. Skip on CSV to keep
  // the response tight.
  let facets = null
  if (!isCsv && q.page === 1) {
    facets = await loadFacets(db, q, scopeLocationIds)
  }

  if (isCsv) {
    const csv = toCsv(data || [])
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`, // eslint-disable-line guardrails/no-utc-today -- CSV export filename suffix; a UTC date key, not a business date
        'Cache-Control': 'no-store',
      },
    })
  }

  return NextResponse.json({
    success: true,
    data: data || [],
    page: q.page,
    page_size: q.page_size,
    total: count || 0,
    facets,
  })
}

// Pulls a deduped list of distinct action keys (within the
// currently-filtered category, if any) so the UI's action <select>
// is auto-populated from the data instead of being hardcoded. Cheap
// — the per-category indexes from migration 180 make this a quick
// index scan.
async function loadFacets(db, q, scopeLocationIds = null) {
  try {
    let actionsQuery = db
      .from('audit_events')
      .select('action', { count: 'exact', head: false })
      .order('action', { ascending: true })
      .limit(500)
    // Mirror the main query's non-master location scoping so the action
    // picker can't leak the existence of actions from other tenants.
    if (scopeLocationIds) actionsQuery = actionsQuery.in('location_id', scopeLocationIds)
    if (q.category) actionsQuery = actionsQuery.eq('category', q.category)
    const { data: actionRows } = await actionsQuery
    const actions = Array.from(new Set((actionRows || []).map((r) => r.action))).sort()
    return { categories: CATEGORIES, actions }
  } catch {
    return { categories: CATEGORIES, actions: [] }
  }
}

// CSV serialiser — spreadsheet-friendly. Flattens the joined
// actor/target/location into named columns. Keeps details as a
// JSON string (CSV can't represent nested data well; importers
// can re-parse the column when needed).
function toCsv(rows) {
  const header = [
    'occurred_at',
    'category',
    'action',
    'actor_name',
    'actor_email',
    'target_name',
    'target_email',
    'target_resource',
    'location_name',
    'ip_address',
    'details_json',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      csvField(r.occurred_at),
      csvField(r.category),
      csvField(r.action),
      csvField(r.actor?.full_name || r.actor_label),
      csvField(r.actor?.email),
      csvField(r.target?.full_name || r.target_label),
      csvField(r.target?.email),
      csvField(r.target_resource),
      csvField(r.location?.name),
      csvField(r.ip_address),
      csvField(r.details ? JSON.stringify(r.details) : ''),
    ].join(','))
  }
  return lines.join('\n')
}

function csvField(v) {
  if (v == null) return ''
  const s = String(v)
  // Quote any field containing comma, quote, or newline.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
