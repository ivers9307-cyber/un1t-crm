// GET /api/admin/audit-log — Master-only paginated read of
// assignment_change_log with filters.
//
// Query params:
//   actor_id?           Filter by who performed the change.
//   target_profile_id?  Filter by who was affected.
//   location_id?        Filter to a specific location.
//   action?             Filter to a single action type
//                       (assignment_create / _update / _delete /
//                       master_promote / _demote / profile_*).
//   from?               ISO 8601 — only entries created at or after.
//   to?                 ISO 8601 — only entries created at or before.
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
//
// Or on format=csv: text/csv body with the same rows flattened.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  actor_id: uuidLike.optional(),
  target_profile_id: uuidLike.optional(),
  location_id: uuidLike.optional(),
  action: z.string().min(1).max(50).optional(),
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
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
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

  // Build the query. Foreign-key joins via PostgREST embed syntax.
  // The actor and target both reference profiles, so we need disambiguating
  // alias names (the FKs are actor_id and target_profile_id).
  let query = db
    .from('assignment_change_log')
    .select(`
      id, action, before, after, created_at,
      actor:actor_id ( id, full_name, email ),
      target:target_profile_id ( id, full_name, email ),
      location:location_id ( id, name )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })

  if (q.actor_id) query = query.eq('actor_id', q.actor_id)
  if (q.target_profile_id) query = query.eq('target_profile_id', q.target_profile_id)
  if (q.location_id) query = query.eq('location_id', q.location_id)
  if (q.action) query = query.eq('action', q.action)
  if (q.from) query = query.gte('created_at', q.from)
  if (q.to) query = query.lte('created_at', q.to)

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

  if (isCsv) {
    const csv = toCsv(data || [])
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
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
  })
}

// CSV serialiser — spreadsheet-friendly. Flattens the joined
// actor/target/location into named columns. Keeps before/after as
// JSON strings (CSV can't represent nested data well; importers
// can re-parse the column when needed).
function toCsv(rows) {
  const header = [
    'created_at',
    'action',
    'actor_name',
    'actor_email',
    'target_name',
    'target_email',
    'location_name',
    'before_json',
    'after_json',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      csvField(r.created_at),
      csvField(r.action),
      csvField(r.actor?.full_name),
      csvField(r.actor?.email),
      csvField(r.target?.full_name),
      csvField(r.target?.email),
      csvField(r.location?.name),
      csvField(r.before ? JSON.stringify(r.before) : ''),
      csvField(r.after ? JSON.stringify(r.after) : ''),
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
