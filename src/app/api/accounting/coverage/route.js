// src/app/api/accounting/coverage/route.js
//
// RCOV.P0 — board data: lines (filterable) + headline stats for the
// active location. Service-role client; access enforced here.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUSES = ['uncovered', 'submitted', 'covered', 'not_found', 'needs_attention', 'ignored']
const OPEN_STATUSES = ['uncovered', 'submitted', 'not_found', 'needs_attention']

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = Math.min(Number(searchParams.get('limit') || 200), 500)

  const db = createServerClient()

  let query = db
    .from('recon_bank_lines')
    .select('id, xero_bank_account_id, bank_account_name, line_date, amount, description, reference, status, first_seen_at, invoices_queue_id, hunt_queued_at, hunt_claimed_at, last_hunted_at, hunt_attempts')
    .eq('location_id', locationId)
    .order('line_date', { ascending: false })
    .limit(limit)
  if (status && STATUSES.includes(status)) query = query.eq('status', status)
  else if (status !== 'all') query = query.in('status', OPEN_STATUSES)
  const { data: lines, error } = await query
  if (error) {
    console.error('[accounting/coverage] lines query failed:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const counts = {}
  for (const s of STATUSES) {
    const { count, error: countErr } = await db
      .from('recon_bank_lines')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', s)
    if (countErr) {
      console.error('[accounting/coverage] status count failed:', countErr)
      return NextResponse.json({ success: false, error: countErr.message }, { status: 500 })
    }
    counts[s] = count || 0
  }

  const { data: lastRun } = await db
    .from('recon_runs')
    .select('started_at, finished_at, status, trigger, error')
    .eq('location_id', locationId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({ success: true, data: { lines: lines || [], counts, lastRun } })
}
