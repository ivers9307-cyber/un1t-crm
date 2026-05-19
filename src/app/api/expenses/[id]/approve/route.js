// FTE-EXPENSES.1 — POST /api/expenses/[id]/approve
//
// Master/owner-only. Flips submitted → approved + triggers the
// Xero bills-email forward. Reimbursement happens via payroll;
// approval is the green-light for the accountant to include it
// in the next run.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { canTransition, periodLabel } from '@/lib/fte-expenses'
import { notifyUsers } from '@/lib/notify'
import { sendFteExpenseClaimBillEmail } from '@/lib/xero/fte-expense-claims'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canApprove(user, claim) {
  if (user.profileRole === 'master' || user.role === 'master') return true
  return Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === claim.location_id)
}

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
  if (!canApprove(user, claim)) {
    return NextResponse.json({ success: false, error: 'Master or owner-at-location only.' }, { status: 403 })
  }
  if (!canTransition(claim.status, 'approved')) {
    return NextResponse.json({ success: false, error: `Cannot approve a claim in '${claim.status}' state.` }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update({
      status: 'approved',
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

  // Xero forward — best effort. The approval has already been
  // recorded; if Postmark/Xero is briefly unreachable we return a
  // success+warning rather than rolling back the approval.
  const warnings = []
  try {
    const fwd = await sendFteExpenseClaimBillEmail(claim.id)
    await db.from('fte_expense_claims').update({
      xero_email_message_id: fwd.messageId,
      xero_synced_at: now,
    }).eq('id', claim.id)
    if (fwd.downloadFailures?.length) {
      warnings.push(`${fwd.downloadFailures.length} receipt download(s) failed during Xero forward — chase manually.`)
    }
  } catch (e) {
    logWarn('expense-approve', 'xero forward failed', { err: e?.message, claimId: claim.id })
    warnings.push(`Xero forward failed: ${e?.message || 'unknown error'}. Retry from the claim page or forward manually.`)
  }

  // Staff notification — push + email fallback via notifyUsers.
  try {
    await notifyUsers([claim.profile_id], {
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
