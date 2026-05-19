// FTE-EXPENSES.1 — single-claim endpoints.
//
// GET    /api/expenses/[id]    detail with items
// PATCH  /api/expenses/[id]    update draft notes/month (only while status=draft)
// DELETE /api/expenses/[id]    delete a draft (only the submitter, only while draft)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { periodForMonth } from '@/lib/fte-expenses'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 'self' wins over 'master' / 'owner' so a privileged user viewing
// their OWN claim sees the submitter UI (Add item, Submit, Revoke,
// Delete-draft) rather than the approver UI (Approve, Decline).
// A user can't approve their own claim anyway — the underlying
// /submit, /approve, /decline, /revoke routes enforce the
// claim.profile_id === user.id check independently — so this
// ordering is purely a UI hint to surface the actions the user
// can actually take.
//
// Prior to the fix, a master who created a draft for themselves
// got viewer_role='master' and the mobile detail screen (which
// gates the Add item button on viewer_role === 'self') hid the
// button, leaving the operator with a draft they could neither
// edit nor submit from mobile. Web flow was unaffected because
// ExpensesManager.jsx compares claim.profile_id to the logged-in
// user id directly rather than reading viewer_role.
function viewerRole(user, claim) {
  if (claim.profile_id === user.id) return 'self'
  if (user.profileRole === 'master' || user.role === 'master') return 'master'
  const ownsLocation = Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === claim.location_id)
  if (ownsLocation) return 'owner'
  return null
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = createServerClient()
  const { data: claim, error } = await db
    .from('fte_expense_claims')
    .select(`
      id, profile_id, location_id,
      period_start, period_end, status,
      total_amount, total_vat_amount, item_count, notes,
      submitted_at, reviewed_at, approved_at, declined_at, revoked_at,
      decline_reason, xero_synced_at, xero_email_message_id,
      created_at, updated_at,
      profile:profile_id ( id, full_name, email ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name ),
      items:fte_expense_items (
        id, expense_date, category, vendor, description,
        amount, vat_amount,
        receipt_path, receipt_size_bytes, receipt_mime_type,
        created_at, updated_at
      )
    `)
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const role = viewerRole(user, claim)
  if (!role) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Sort items by date for the UI.
  const items = Array.isArray(claim.items)
    ? [...claim.items].sort((a, b) => a.expense_date.localeCompare(b.expense_date))
    : []

  return NextResponse.json({
    success: true,
    data: { ...claim, items, viewer_role: role },
  })
}

const PatchSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
})

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select('id, profile_id, location_id, status, period_start')
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can edit this claim.' }, { status: 403 })
  }
  if (claim.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Cannot edit a claim in '${claim.status}' state. Revoke it first if you need to change something.`,
    }, { status: 409 })
  }

  const validation = await validateBody(request, PatchSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const updates = {}
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) updates.notes = body.notes || null
  if (body.month) {
    const period = periodForMonth(body.month)
    if (!period) return NextResponse.json({ success: false, error: 'Invalid month — expected YYYY-MM.' }, { status: 400 })
    updates.period_start = period.period_start
    updates.period_end = period.period_end
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, data: claim })
  }

  const { data: updated, error: updErr } = await db
    .from('fte_expense_claims')
    .update(updates)
    .eq('id', id)
    .eq('status', 'draft') // optimistic concurrency
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  if (!updated) return NextResponse.json({ success: false, error: 'Claim was modified concurrently — refresh and retry.' }, { status: 409 })
  return NextResponse.json({ success: true, data: updated })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select('id, profile_id, status')
    .eq('id', id)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can delete this claim.' }, { status: 403 })
  }
  if (claim.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Can only delete claims in 'draft' state. This one is '${claim.status}'. Revoke instead.`,
    }, { status: 409 })
  }

  // Cascade delete from fte_expense_items via the ON DELETE CASCADE FK
  // dropped at migration 183. Storage receipts under the claim's path
  // prefix are NOT cleaned up by the FK — schedule that as a separate
  // best-effort step here.
  // List the receipt paths first so we can clean them up after the
  // row is gone (in case the storage delete races with the row delete
  // and one fails — at least the row is consistent).
  const { data: items } = await db
    .from('fte_expense_items')
    .select('receipt_path')
    .eq('claim_id', id)
  const paths = (items || []).map((i) => i.receipt_path).filter(Boolean)

  const { error: delErr } = await db
    .from('fte_expense_claims')
    .delete()
    .eq('id', id)
    .eq('status', 'draft') // belt + braces in case of race
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })

  if (paths.length > 0) {
    // Best-effort. Don't surface a storage error to the caller —
    // the claim is gone, orphan files can be reaped by a cron later.
    try { await db.storage.from('fte-expense-receipts').remove(paths) } catch { /* ignore */ }
  }

  return NextResponse.json({ success: true })
}
