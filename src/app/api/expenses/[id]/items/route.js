// FTE-EXPENSES.1 — POST /api/expenses/[id]/items
//
// Add a line item to a draft claim. Fields:
//   - expense_date    (YYYY-MM-DD)
//   - category        (one of EXPENSE_CATEGORIES)
//   - amount          (positive number)
//   - vat_amount      (>= 0, <= amount)
//   - vendor          (optional, max 200)
//   - description     (optional, max 500)
//   - receipt         (optional, but expected for most categories)
//
// Submitter-only; only valid while the parent claim is in 'draft' state.
//
// MOBILE-UPLOAD.1 — two body shapes carry the receipt:
//   JSON       the current app. The bytes are already in the bucket — the
//              device uploaded them against a slot from
//              /api/expenses/[id]/upload-sign — so the body carries a path
//              and the row is inserted complete, in one write.
//   multipart  the browser, and phone bundles that predate that OTA: the
//              receipt rides inline and is uploaded here, which needs the
//              row's id first and so inserts, uploads, then patches.
// A multipart file part has not reached this route from a phone since the
// Expo SDK 57 upgrade (nothing has landed in the bucket since 15 Jul), and
// Vercel's ~4.5 MB body cap made the advertised 10 MB receipt unpostable
// that way regardless.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  EXPENSE_CATEGORIES,
  RECEIPT_ACCEPTED_MIMES,
  RECEIPT_MAX_BYTES,
  buildReceiptPath,
  isExpenseReceiptPath,
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

  const isJsonMode = (request.headers.get('content-type') || '').includes('application/json')

  let expenseDate, category, amount, vatAmount, vendor, description
  let file = null          // multipart mode: the inline File
  let jsonReceipt = null   // JSON mode: { path, name, size, mime }

  if (isJsonMode) {
    let body
    try { body = await request.json() }
    catch { return NextResponse.json({ success: false, error: 'Expected a JSON body.' }, { status: 400 }) }

    expenseDate = String(body?.expense_date || '')
    category    = String(body?.category || '')
    amount      = Number(body?.amount)
    vatAmount   = Number(body?.vat_amount || 0)
    vendor      = body?.vendor ? String(body.vendor).slice(0, 200) : null
    description = body?.description ? String(body.description).slice(0, 500) : null
    if (body?.receipt) {
      jsonReceipt = {
        path: String(body.receipt.path || ''),
        name: String(body.receipt.file_name || 'receipt'),
        size: Number(body.receipt.size),
        mime: String(body.receipt.mime || '').toLowerCase(),
      }
    }
  } else {
    let form
    try { form = await request.formData() }
    catch { return NextResponse.json({ success: false, error: 'Expected multipart/form-data.' }, { status: 400 }) }

    expenseDate = String(form.get('expense_date') || '')
    category    = String(form.get('category') || '')
    amount      = Number(form.get('amount'))
    vatAmount   = Number(form.get('vat_amount') || 0)
    vendor      = String(form.get('vendor') || '').slice(0, 200) || null
    description = String(form.get('description') || '').slice(0, 500) || null
    file        = form.get('receipt')
  }

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

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
  const row = {
    claim_id: claimId,
    expense_date: expenseDate,
    category,
    amount: round2(amount),
    vat_amount: round2(vatAmount),
    vendor,
    description,
  }

  // ---- JSON mode: prove the receipt BEFORE inserting anything ----------
  // Nothing is created if the receipt is bad, so there is no half-made row
  // to explain (the multipart branch below cannot manage that — it needs
  // the row's id to build the storage path).
  if (isJsonMode && jsonReceipt) {
    if (!isExpenseReceiptPath(jsonReceipt.path, user.id, claimId)) {
      return NextResponse.json(
        { success: false, error: 'That receipt is not an upload slot for this claim.', code: 'receipt_bad_path' },
        { status: 400 }
      )
    }

    const { data: claimed, error: claimErr } = await db
      .from('fte_expense_items')
      .select('id')
      .eq('receipt_path', jsonReceipt.path)
      .limit(1)
    if (claimErr) {
      return NextResponse.json({ success: false, error: `Could not verify the receipt: ${claimErr.message}` }, { status: 500 })
    }
    if (claimed && claimed.length > 0) {
      return NextResponse.json(
        { success: false, error: 'That receipt already belongs to another item — attach it again.', code: 'receipt_already_used' },
        { status: 400 }
      )
    }

    const parts = jsonReceipt.path.split('/')
    const name = parts.pop()
    const { data: listed, error: listErr } = await db.storage
      .from(STORAGE_BUCKET)
      .list(parts.join('/'), { search: name })
    if (listErr) {
      return NextResponse.json({ success: false, error: `Could not verify the receipt: ${listErr.message}` }, { status: 500 })
    }
    const hit = (listed || []).find((o) => o.name === name)
    if (!hit) {
      return NextResponse.json(
        { success: false, error: 'The receipt did not finish uploading — attach it again.', code: 'receipt_missing' },
        { status: 400 }
      )
    }

    // Size and type come from what Storage actually holds — the client's
    // numbers were a hint for the sign step, and anyone can post JSON.
    const storedSize = Number(hit.metadata?.size)
    const storedMime = String(hit.metadata?.mimetype || jsonReceipt.mime || '').toLowerCase()
    if (!Number.isFinite(storedSize) || storedSize <= 0) {
      await db.storage.from(STORAGE_BUCKET).remove([jsonReceipt.path]).then(() => {}, () => {})
      return NextResponse.json({ success: false, error: 'The receipt is empty or unreadable.', code: 'receipt_empty' }, { status: 400 })
    }
    if (storedSize > RECEIPT_MAX_BYTES) {
      await db.storage.from(STORAGE_BUCKET).remove([jsonReceipt.path]).then(() => {}, () => {})
      return NextResponse.json({
        success: false,
        error: `Receipt too large (max ${(RECEIPT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
        code: 'receipt_too_large',
      }, { status: 400 })
    }
    if (!RECEIPT_ACCEPTED_MIMES.includes(storedMime)) {
      await db.storage.from(STORAGE_BUCKET).remove([jsonReceipt.path]).then(() => {}, () => {})
      return NextResponse.json({
        success: false,
        error: `Receipt type ${storedMime || 'unknown'} not accepted. Use PDF or a phone-camera image (PNG / JPEG / HEIC / WebP).`,
        code: 'receipt_bad_type',
      }, { status: 400 })
    }

    row.receipt_path = jsonReceipt.path
    row.receipt_size_bytes = storedSize
    row.receipt_mime_type = storedMime
  }

  const { data: created, error: insErr } = await db
    .from('fte_expense_items')
    .insert(row)
    .select()
    .single()
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })

  if (isJsonMode) {
    return NextResponse.json({ success: true, data: created }, { status: 201 })
  }

  // ---- multipart mode: upload the inline bytes, then patch the row -----
  // The path is namespaced by the item, so the row has to exist first. If
  // anything fails the row stays with no receipt — the submitter can retry
  // the upload via PATCH later, which is why item_id rides on the error.
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
