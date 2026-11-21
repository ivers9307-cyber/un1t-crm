// FTE-EXPENSES.1 — POST /api/expenses/[id]/decline
//
// Master/owner-only. Flips submitted → declined with a required
// reason. Employee can submit a fresh claim for the same period
// (the partial unique index excludes declined rows from the
// uniqueness predicate).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { canApproveExpenseClaim, canSeeExpenseClaim } from '@/lib/fte-expense-access'
import { validateBody } from '@/lib/validate'
import { canTransition, periodLabel } from '@/lib/fte-expenses'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  reason: z.string().min(1).max(1000),
})

// withAuth only signs the caller in (the same 401). The body, the claim (404),
// own claim (403), the approver check (403) and the state (409) keep their
// order; the write, the push and the audit row are unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const { id } = params

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const { data: claim } = await db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id, status, period_start, total_amount,
      profile:profile_id ( id, full_name, email )
    `)
    .eq('id', id)
    .maybeSingle()
  // FINALTIDY.1 — a caller who can't see the claim gets the same 404 as a
  // missing one. APPROVALS-PERCAT.1 — the permission is still the only gate
  // to ACT; a caller who can see the claim (the claimant, an owner whose
  // approvals_fte_expenses was switched off) keeps the honest 403.
  if (!claim || !canSeeExpenseClaim(user, claim)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // FINALTIDY.1 — nobody decides on their own spend, master included. The
  // claimant can see the claim, so this is an honest 403; to pull a claim
  // back they revoke it instead.
  if (claim.profile_id === user.id) {
    return NextResponse.json({ success: false, error: "You can't decline your own expense claim. Revoke it instead if you need to change it." }, { status: 403 })
  }
  if (!canApproveExpenseClaim(user, claim)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to decline expenses.' }, { status: 403 })
  }
  if (!canTransition(claim.status, 'declined')) {
    return NextResponse.json({ success: false, error: `Cannot decline a claim in '${claim.status}' state.` }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update({
      status: 'declined',
      reviewed_at: now,
      reviewed_by: user.id,
      declined_at: now,
      decline_reason: reason,
    })
    .eq('id', id)
    .eq('status', 'submitted')
    .select()
    .single()
  if (updErr) {
    logError('expenses-decline', 'decline update failed', { claimId: id, err: updErr })
    return NextResponse.json({ success: false, error: 'Could not decline the claim. Refresh and try again.' }, { status: 500 })
  }
  if (!updated) return NextResponse.json({ success: false, error: 'Claim was reviewed by someone else — refresh and retry.' }, { status: 409 })

  const warnings = []
  try {
    await notifyUsersOnce(db, `expense_declined:${claim.id}`, [claim.profile_id], {
      title: 'Expense claim declined',
      body: `Your €${Number(claim.total_amount).toFixed(2)} claim for ${periodLabel(claim.period_start)} was declined. Reason: ${reason.slice(0, 200)}`,
      emailSubject: `Expense claim declined — ${periodLabel(claim.period_start)}`,
      category: 'expense_declined',
      data: { type: 'expense_declined', claim_id: claim.id },
    })
  } catch (e) {
    logError('expenses-decline', 'decline notification failed', { claimId: claim.id, err: e?.message || String(e) })
    warnings.push('The claimant could not be notified.')
  }

  await logAuditEvent({
    category: 'business',
    action: 'expense_claim.declined',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id: claim.profile_id, label: claim.profile?.full_name, resource: `expense_claims/${claim.id}` },
    locationId: claim.location_id,
    details: { period_start: claim.period_start, total_amount: claim.total_amount, reason },
    request,
  })

  return NextResponse.json({
    success: true,
    data: updated,
    warning: warnings.length ? warnings.join(' ') : undefined,
  })
})
