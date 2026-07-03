// FTE-EXPENSES.1 — POST /api/expenses/[id]/submit
//
// Flips a draft claim → submitted. Submitter-only. Requires at
// least one line item (an empty claim has nothing to approve).
// Sends an approval-pending notification to the location's owners +
// master(s) so they know there's something in their queue.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canTransition, periodLabel } from '@/lib/fte-expenses'
import { sendPushToRolesAtLocationOnce } from '@/lib/push-dedup'
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
    .select('id, profile_id, location_id, status, period_start, item_count, total_amount, location:location_id(name)')
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can submit this claim.' }, { status: 403 })
  }
  if (!canTransition(claim.status, 'submitted')) {
    return NextResponse.json({
      success: false,
      error: `Cannot submit a claim in '${claim.status}' state.`,
    }, { status: 409 })
  }
  if (!claim.item_count || claim.item_count === 0) {
    return NextResponse.json({
      success: false,
      error: 'Add at least one expense line item before submitting.',
    }, { status: 400 })
  }

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update({ status: 'submitted', submitted_at: now })
    .eq('id', id)
    .eq('status', 'draft')
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) return NextResponse.json({ success: false, error: 'Claim status changed concurrently — refresh and retry.' }, { status: 409 })

  // Notify approvers (owners at the location + masters platform-
  // wide). Best-effort.
  try {
    await sendPushToRolesAtLocationOnce(db, `expense_submitted:${claim.id}:${updated.submitted_at || ''}`, claim.location_id, ['owner', 'master'], {
      title: 'Expense claim awaiting approval',
      body: `${user.full_name || 'A staff member'} submitted €${Number(claim.total_amount).toFixed(2)} for ${periodLabel(claim.period_start)}`,
      category: 'expense_submitted',
      data: { type: 'expense_submitted', claim_id: claim.id },
    })
  } catch { /* swallow */ }

  await logAuditEvent({
    category: 'business',
    action: 'expense_claim.submitted',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: user.id, label: user.full_name, resource: `expense_claims/${claim.id}` },
    locationId: claim.location_id,
    details: {
      period_start: claim.period_start,
      total_amount: claim.total_amount,
      item_count: claim.item_count,
    },
    request,
  })

  return NextResponse.json({ success: true, data: updated })
}
