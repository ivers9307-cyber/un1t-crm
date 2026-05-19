// FTE-EXPENSES.1 — POST /api/expenses/[id]/revoke
//
// Submitter-only. Flips submitted → revoked when the employee
// spots an issue right after submitting (a typo, wrong period,
// missing receipt). Allows them to start a fresh claim for the
// same period — the partial unique index excludes revoked rows.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canTransition } from '@/lib/fte-expenses'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select('id, profile_id, location_id, status, period_start, total_amount')
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can revoke this claim.' }, { status: 403 })
  }
  if (!canTransition(claim.status, 'revoked')) {
    return NextResponse.json({ success: false, error: `Cannot revoke a claim in '${claim.status}' state.` }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update({ status: 'revoked', revoked_at: now })
    .eq('id', id)
    .eq('status', 'submitted')
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) return NextResponse.json({ success: false, error: 'Claim status changed concurrently — refresh and retry.' }, { status: 409 })

  await logAuditEvent({
    category: 'business',
    action: 'expense_claim.revoked',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: user.id, label: user.full_name, resource: `expense_claims/${claim.id}` },
    locationId: claim.location_id,
    details: { period_start: claim.period_start, total_amount: claim.total_amount },
    request,
  })

  return NextResponse.json({ success: true, data: updated })
}
