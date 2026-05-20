// FTE-EXPENSES.1 — collection endpoints for monthly expense claims.
//
// POST /api/expenses — create a draft claim (employee, FTE-only)
// GET  /api/expenses — list claims (role-scoped: self / owner / master)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { periodForMonth } from '@/lib/fte-expenses'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  // YYYY-MM. Resolved into period_start/end on the server so the DB
  // CHECK on date_trunc('month', period_start) is always satisfied.
  month: z.string().regex(/^\d{4}-\d{2}$/),
  location_id: uuidLike,
  notes: z.string().max(2000).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.employment_type !== 'fte') {
    return NextResponse.json({
      success: false,
      error: 'Expense reimbursement is for FTE employees only. Contractors use the invoices flow.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const { month, location_id, notes } = validation.data

  // Confirm the caller is actually assigned to this location.
  const inLocation = (user.locations || []).some((l) => l.id === location_id)
  if (!inLocation) {
    return NextResponse.json({
      success: false,
      error: 'You must be assigned to this location to submit an expense claim against it.',
    }, { status: 403 })
  }

  const period = periodForMonth(month)
  if (!period) {
    return NextResponse.json({ success: false, error: 'Invalid month — expected YYYY-MM.' }, { status: 400 })
  }

  const db = createServerClient()

  // Partial unique index guards against (profile, location, period)
  // collisions for non-terminal claims. Surface a friendly error
  // when the operator tries to start a second draft for a month
  // that already has an in-flight claim.
  const { data: existing } = await db
    .from('fte_expense_claims')
    .select('id, status')
    .eq('profile_id', user.id)
    .eq('location_id', location_id)
    .eq('period_start', period.period_start)
    .not('status', 'in', '("declined","revoked")')
    .maybeSingle()
  if (existing) {
    return NextResponse.json({
      success: false,
      error: `You already have a ${existing.status} expense claim for ${period.label} at this location. Open it to keep editing, or revoke it to start fresh.`,
      existing_id: existing.id,
    }, { status: 409 })
  }

  const { data: claim, error: insErr } = await db
    .from('fte_expense_claims')
    .insert({
      profile_id: user.id,
      location_id,
      period_start: period.period_start,
      period_end: period.period_end,
      notes: notes || null,
      status: 'draft',
    })
    .select()
    .single()
  if (insErr) {
    return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: claim }, { status: 201 })
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get('status') // optional comma-list
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const db = createServerClient()

  let query = db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id,
      period_start, period_end, status,
      total_amount, total_vat_amount, item_count, notes,
      submitted_at, reviewed_at, approved_at, declined_at, revoked_at,
      decline_reason, xero_synced_at,
      profile:profile_id ( id, full_name, email ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .order('period_start', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  // Scope — ORG-ISOLATION: each location is its own business.
  //   • master + owner: see all claims AT the active location only,
  //     plus their own claims anywhere. Switch active to see
  //     another studio.
  //   • Plain staff: only their own claims.
  const isMaster = user.role === 'master' || user.profileRole === 'master'
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)
  const activeId = user.activeLocation?.id || null
  const canViewLocationScope = isMaster || ownerLocations.length > 0
  if (canViewLocationScope) {
    if (!activeId) {
      // No active location → caller sees own claims only.
      query = query.eq('profile_id', user.id)
    } else if (!isMaster && !ownerLocations.includes(activeId)) {
      // Active location isn't one they own (e.g. they're a manager
      // visiting another studio) — fall back to own claims only.
      query = query.eq('profile_id', user.id)
    } else {
      query = query.or(`profile_id.eq.${user.id},location_id.eq.${activeId}`)
    }
  } else {
    query = query.eq('profile_id', user.id)
  }

  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length > 0) query = query.in('status', statuses)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}
