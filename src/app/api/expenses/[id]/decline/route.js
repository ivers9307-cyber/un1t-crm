// FTE-EXPENSES.1 — POST /api/expenses/[id]/decline
//
// Master/owner-only. Flips submitted → declined with a required
// reason. Employee can submit a fresh claim for the same period
// (the partial unique index excludes declined rows from the
// uniqueness predicate).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { canTransition, periodLabel } from '@/lib/fte-expenses'
import { notifyUsers } from '@/lib/notify'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  reason: z.string().min(1).max(1000),
})

function canDecline(user, claim) {
  if (user.profileRole === 'master' || user.role === 'master') return true
  return Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === claim.location_id)
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id, status, period_start, total_amount,
      profile:profile_id ( id, full_name, email )
    `)
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!canDecline(user, claim)) {
    return NextResponse.json({ success: false, error: 'Master or owner-at-location only.' }, { status: 403 })
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
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) return NextResponse.json({ success: false, error: 'Claim was reviewed by someone else — refresh and retry.' }, { status: 409 })

  const warnings = []
  try {
    await notifyUsers([claim.profile_id], {
      title: 'Expense claim declined',
      body: `Your €${Number(claim.total_amount).toFixed(2)} claim for ${periodLabel(claim.period_start)} was declined. Reason: ${reason.slice(0, 200)}`,
      emailSubject: `Expense claim declined — ${periodLabel(claim.period_start)}`,
      category: 'expense_declined',
      data: { type: 'expense_declined', claim_id: claim.id },
    })
  } catch (e) {
    warnings.push(`Notification failed: ${e?.message || 'unknown'}`)
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
}
