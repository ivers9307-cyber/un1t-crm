// FTE-EXPENSES.1 — PATCH / DELETE a single line item.
//
// PATCH supports updating fields (and replacing the receipt via a
// multipart upload). DELETE removes the line item and its receipt
// from Storage. Both submitter-only, draft-only.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  EXPENSE_CATEGORIES,
  RECEIPT_ACCEPTED_MIMES,
  RECEIPT_MAX_BYTES,
  buildReceiptPath,
} from '@/lib/fte-expenses'
import { isoDate } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

// All fields optional — PATCH updates only the fields supplied.
const PatchExpenseItemBody = z.object({
  expense_date: isoDate.optional(),
  category: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  vat_amount: z.union([z.number(), z.string()]).optional(),
  vendor: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'fte-expense-receipts'

async function loadClaimAndItem(db, claimId, itemId) {
  const { data: item } = await db
    .from('fte_expense_items')
    .select(`
      id, claim_id, receipt_path,
      claim:claim_id ( id, profile_id, status )
    `)
    .eq('id', itemId)
    .eq('claim_id', claimId)
    .maybeSingle()
  return item
}

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: claimId, itemId } = await params

  const db = createServerClient()
  const item = await loadClaimAndItem(db, claimId, itemId)
  if (!item) return NextResponse.json({ success: false, error: 'Item not found' }, { status: 404 })
  if (item.claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can edit this item.' }, { status: 403 })
  }
  if (item.claim.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Cannot edit items on a claim in '${item.claim.status}' state.`,
    }, { status: 409 })
  }

  const contentType = request.headers.get('content-type') || ''
  const isMultipart = contentType.includes('multipart/form-data')
  let body = {}
  let file = null
  if (isMultipart) {
    const form = await request.formData()
    for (const [k, v] of form.entries()) {
      if (k === 'receipt' && typeof v === 'object' && v.size > 0) { file = v; continue }
      body[k] = typeof v === 'string' ? v : null
    }
  } else {
    const validation = await validateBody(request, PatchExpenseItemBody, { allowEmpty: true })
    if (!validation.ok) return validation.response
    body = validation.data
  }

  // Build the update set defensively — only known fields, with the
  // same validation rules as the POST route.
  const updates = {}
  if (body.expense_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.expense_date)) {
      return NextResponse.json({ success: false, error: 'expense_date must be YYYY-MM-DD' }, { status: 400 })
    }
    updates.expense_date = body.expense_date
  }
  if (body.category !== undefined) {
    if (!EXPENSE_CATEGORIES.includes(body.category)) {
      return NextResponse.json({ success: false, error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` }, { status: 400 })
    }
    updates.category = body.category
  }
  if (body.amount !== undefined) {
    const a = Number(body.amount)
    if (!Number.isFinite(a) || a <= 0) {
      return NextResponse.json({ success: false, error: 'amount must be > 0' }, { status: 400 })
    }
    updates.amount = round2(a)
  }
  if (body.vat_amount !== undefined) {
    const v = Number(body.vat_amount)
    // The DB CHECK vat <= amount can fail if we don't know the new
    // amount yet. Compute clamp at write time using the eventual
    // amount (either patched or existing).
    const targetAmount = updates.amount ?? (await currentAmount(db, itemId)) ?? Infinity
    if (!Number.isFinite(v) || v < 0 || v > targetAmount) {
      return NextResponse.json({ success: false, error: 'vat_amount must be between 0 and amount' }, { status: 400 })
    }
    updates.vat_amount = round2(v)
  }
  if (body.vendor !== undefined) updates.vendor = body.vendor ? String(body.vendor).slice(0, 200) : null
  if (body.description !== undefined) updates.description = body.description ? String(body.description).slice(0, 500) : null

  if (file) {
    if (file.size > RECEIPT_MAX_BYTES) {
      return NextResponse.json({
        success: false,
        error: `Receipt too large (max ${(RECEIPT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
      }, { status: 400 })
    }
    const mime = file.type || 'application/octet-stream'
    if (!RECEIPT_ACCEPTED_MIMES.includes(mime)) {
      return NextResponse.json({ success: false, error: `Receipt type ${mime} not accepted.` }, { status: 400 })
    }
    const path = buildReceiptPath({
      profileId: user.id,
      claimId,
      itemId,
      filename: file.name || 'receipt',
    })
    const ab = await file.arrayBuffer()
    const { error: upErr } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(path, Buffer.from(ab), { contentType: mime, upsert: false })
    if (upErr) return NextResponse.json({ success: false, error: `Receipt upload failed: ${upErr.message}` }, { status: 500 })
    // Delete the previous receipt if one existed (orphan cleanup).
    if (item.receipt_path) {
      try { await db.storage.from(STORAGE_BUCKET).remove([item.receipt_path]) } catch { /* ignore */ }
    }
    updates.receipt_path = path
    updates.receipt_size_bytes = file.size
    updates.receipt_mime_type = mime
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true })
  }

  const { data: patched, error: updErr } = await db
    .from('fte_expense_items')
    .update(updates)
    .eq('id', itemId)
    .select()
    .single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: patched })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: claimId, itemId } = await params

  const db = createServerClient()
  const item = await loadClaimAndItem(db, claimId, itemId)
  if (!item) return NextResponse.json({ success: false, error: 'Item not found' }, { status: 404 })
  if (item.claim.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Only the submitter can delete items.' }, { status: 403 })
  }
  if (item.claim.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Cannot delete items on a claim in '${item.claim.status}' state.`,
    }, { status: 409 })
  }

  const { error: delErr } = await db
    .from('fte_expense_items')
    .delete()
    .eq('id', itemId)
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })

  if (item.receipt_path) {
    try { await db.storage.from(STORAGE_BUCKET).remove([item.receipt_path]) } catch { /* ignore */ }
  }
  return NextResponse.json({ success: true })
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100 }

async function currentAmount(db, itemId) {
  const { data } = await db
    .from('fte_expense_items')
    .select('amount')
    .eq('id', itemId)
    .maybeSingle()
  return data ? Number(data.amount) : null
}
