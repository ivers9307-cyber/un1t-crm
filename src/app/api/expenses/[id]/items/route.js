// FTE-EXPENSES.1 — POST /api/expenses/[id]/items
//
// Add a line item to a draft claim. Multipart form upload:
//   - expense_date    (YYYY-MM-DD)
//   - category        (one of EXPENSE_CATEGORIES)
//   - amount          (positive number)
//   - vat_amount      (>= 0, <= amount)
//   - vendor          (optional, max 200)
//   - description     (optional, max 500)
//   - receipt         (optional file, but expected for most categories)
//
// Submitter-only; only valid while the parent claim is in 'draft'
// state. Multipart so the receipt PNG/JPG/PDF lands in one round-
// trip — same pattern as POST /api/invoices.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  EXPENSE_CATEGORIES,
  RECEIPT_ACCEPTED_MIMES,
  RECEIPT_MAX_BYTES,
  buildReceiptPath,
} from '@/lib/fte-expenses'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'fte-expense-receipts'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: claimId } = await params

  const db = createServerClient()
  const { data: claim } = await db
    .from('fte_expense_claims')
    .select('id, profile_id, status')
    .eq('id', claimId)
    .maybeSingle()
  if (!claim) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can add items.' }, { status: 403 })
  }
  if (claim.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Cannot add items to a claim in '${claim.status}' state. Revoke first if you need to change something.`,
    }, { status: 409 })
  }

  let form
  try { form = await request.formData() }
  catch { return NextResponse.json({ success: false, error: 'Expected multipart/form-data.' }, { status: 400 }) }

  const expenseDate = String(form.get('expense_date') || '')
  const category = String(form.get('category') || '')
  const amount = Number(form.get('amount'))
  const vatAmount = Number(form.get('vat_amount') || 0)
  const vendor = String(form.get('vendor') || '').slice(0, 200) || null
  const description = String(form.get('description') || '').slice(0, 500) || null
  const file = form.get('receipt')

  // Field validation. Stays in-route for clarity rather than calling
  // into validateBody — multipart needs ad-hoc handling.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
    return NextResponse.json({ success: false, error: 'expense_date must be YYYY-MM-DD' }, { status: 400 })
  }
  if (!EXPENSE_CATEGORIES.includes(category)) {
    return NextResponse.json({ success: false, error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` }, { status: 400 })
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ success: false, error: 'amount must be > 0' }, { status: 400 })
  }
  if (!Number.isFinite(vatAmount) || vatAmount < 0 || vatAmount > amount) {
    return NextResponse.json({ success: false, error: 'vat_amount must be between 0 and amount' }, { status: 400 })
  }

  // First insert the row WITHOUT a receipt path — gives us an id we
  // can use to build the storage key (so the path is namespaced by
  // item, not just by claim, which keeps the bucket browsable).
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
  const { data: created, error: insErr } = await db
    .from('fte_expense_items')
    .insert({
      claim_id: claimId,
      expense_date: expenseDate,
      category,
      amount: round2(amount),
      vat_amount: round2(vatAmount),
      vendor,
      description,
    })
    .select()
    .single()
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })

  // If a receipt was attached, upload it now and patch the row with
  // the path. If anything fails the row stays with no receipt — the
  // submitter can retry the upload via PATCH later.
  if (file && typeof file === 'object' && file.size > 0) {
    if (file.size > RECEIPT_MAX_BYTES) {
      return NextResponse.json({
        success: false,
        error: `Receipt too large (max ${(RECEIPT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
        item_id: created.id, // row created; receipt upload failed
      }, { status: 400 })
    }
    const mime = file.type || 'application/octet-stream'
    if (!RECEIPT_ACCEPTED_MIMES.includes(mime)) {
      return NextResponse.json({
        success: false,
        error: `Receipt type ${mime} not accepted. Use PDF or a phone-camera image (PNG / JPEG / HEIC / WebP).`,
        item_id: created.id,
      }, { status: 400 })
    }
    const path = buildReceiptPath({
      profileId: user.id,
      claimId,
      itemId: created.id,
      filename: file.name || 'receipt',
    })
    const ab = await file.arrayBuffer()
    const { error: upErr } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(path, Buffer.from(ab), { contentType: mime, upsert: false })
    if (upErr) {
      return NextResponse.json({
        success: false,
        error: `Receipt upload failed: ${upErr.message}`,
        item_id: created.id,
      }, { status: 500 })
    }
    const { data: patched } = await db
      .from('fte_expense_items')
      .update({
        receipt_path: path,
        receipt_size_bytes: file.size,
        receipt_mime_type: mime,
      })
      .eq('id', created.id)
      .select()
      .single()
    return NextResponse.json({ success: true, data: patched || created }, { status: 201 })
  }

  return NextResponse.json({ success: true, data: created }, { status: 201 })
}
