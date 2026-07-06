// FTE-EXPENSES.1 — POST /api/expenses/[id]/approve
//
// Master/owner-only. INVOICES-QUEUE.1 (mig 185): owner approval no
// longer forwards directly to Xero. Instead it flips the claim to
// 'awaiting_accountant_review' and drops one row per receipt into
// the central invoices_queue, where the bookkeeper handles the
// Claude Vision analysis + final Xero forward in /invoices.
//
// Reimbursement still happens via payroll. The bookkeeper handoff
// is invisible to the submitter — they just see "Approved by your
// manager · Awaiting accountant sign-off before forwarding to
// Xero."

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { canTransition, periodLabel } from '@/lib/fte-expenses'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { enqueueFromFteExpenseClaim } from '@/lib/invoices-queue/enqueue'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id, status, period_start, total_amount, item_count,
      profile:profile_id ( id, full_name, email ),
      location:location_id ( id, name )
    `)
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // APPROVALS-PERCAT.1 — permission is the only gate.
  if (!hasPermissionForLocation(user, claim.location_id, APPROVAL_CATEGORY_PERMISSION.fte_expenses)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to approve expenses.' }, { status: 403 })
  }
  if (!canTransition(claim.status, 'approved')) {
    return NextResponse.json({ success: false, error: `Cannot approve a claim in '${claim.status}' state.` }, { status: 409 })
  }

  const now = new Date().toISOString()
  // INVOICES-QUEUE.1 — single update flips submitted →
  // awaiting_accountant_review. The 'approved' intermediate state
  // is recorded via approved_at + reviewed_at + reviewed_by
  // timestamps rather than as a settled status (cleaner audit
  // trail, no churning state machine). The terminal-from-
  // submitter state is awaiting_accountant_review; bookkeeper
  // moves the row through the queue from here.
  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update({
      status: 'awaiting_accountant_review',
      reviewed_at: now,
      reviewed_by: user.id,
      approved_at: now,
    })
    .eq('id', id)
    .eq('status', 'submitted')
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) return NextResponse.json({ success: false, error: 'Claim was reviewed by someone else — refresh and retry.' }, { status: 409 })

  // Drop one row per receipt into the central invoices_queue. The
  // bookkeeper picks them up from /invoices for Claude Vision
  // analysis + Xero forward. Best-effort: if enqueue fails the
  // approval has still been recorded; we return success + warning
  // and the operator can re-enqueue manually from a retry route
  // (PR 2). Rolling back the approval on enqueue failure would
  // make the submitter's UX worse for no real gain.
  const warnings = []
  const enq = await enqueueFromFteExpenseClaim(claim.id)
  if (!enq.ok) {
    logWarn('expense-approve', 'enqueue failed', { err: enq.error, claimId: claim.id })
    warnings.push(`Queue insert failed: ${enq.error}. The approval is recorded; retry enqueue from /invoices.`)
  }

  // Staff notification — push + email fallback via notifyUsers.
  try {
    await notifyUsersOnce(db, `expense_approved:${claim.id}`, [claim.profile_id], {
      title: 'Expense claim approved',
      body: `Your €${Number(claim.total_amount).toFixed(2)} claim for ${periodLabel(claim.period_start)} was approved. Reimbursement goes through with the next payroll run.`,
      emailSubject: `Expense claim approved — ${periodLabel(claim.period_start)}`,
      category: 'expense_approved',
      data: { type: 'expense_approved', claim_id: claim.id },
    })
  } catch (e) {
    warnings.push(`Notification failed: ${e?.message || 'unknown'}`)
  }

  await logAuditEvent({
    category: 'business',
    action: 'expense_claim.approved',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: claim.profile_id, label: claim.profile?.full_name, resource: `expense_claims/${claim.id}` },
    locationId: claim.location_id,
    details: {
      period_start: claim.period_start,
      total_amount: claim.total_amount,
      item_count: claim.item_count,
      xero_warnings: warnings,
    },
    request,
  })

  return NextResponse.json({
    success: true,
    data: updated,
    warning: warnings.length ? warnings.join(' ') : undefined,
  })
}
