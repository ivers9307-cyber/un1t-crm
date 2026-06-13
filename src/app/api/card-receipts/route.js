// /api/card-receipts
//
//   POST  submit a company-card receipt — just the photo (+ optional
//         "which card" last-4 + note). The receipt is already in storage
//         via /api/card-receipts/upload-sign + a signed direct upload;
//         the body carries a pointer. On submit it auto-enqueues into
//         the invoices_queue (status 'received', source_type
//         'card_receipt') — exactly like an emailed supplier invoice —
//         and the bookkeeper's Analyse (OCR) fills amount/merchant/date/
//         VAT in /invoices, then reviews + sends to Xero. NO typed
//         financial fields, NO owner-approval step (SPEND.P3.1).
//   GET   list — the caller's own submitted receipts (history).
//
// Submission is gated by the `card_receipts` permission (card holders).
// The receipt file lives in the private 'company-card-receipts' bucket.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { isCardReceiptPath, sniffReceiptMime, CARD_RECEIPTS_BUCKET, MAX_RECEIPT_BYTES } from '@/lib/card-receipts'
import { enqueueFromCardReceipt } from '@/lib/invoices-queue/enqueue'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const SubmitSchema = z.object({
  card_last4: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.nullable().optional(),
  receipt_path: z.string().min(3).max(300),
  receipt_name: z.string().min(1).max(200),
})

// ── POST: submit a company-card receipt ───────────────────────────
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'card_receipts')) {
    return NextResponse.json(
      { success: false, error: 'You do not have permission to submit company-card receipts.' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, SubmitSchema)
  if (!validation.ok) return validation.response
  const b = validation.data

  // Resolve location. Default to the user's single location; otherwise
  // the body must say which one, and the user must be a member.
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) {
    return NextResponse.json(
      { success: false, error: 'You are not assigned to any location — cannot submit a receipt.' },
      { status: 400 }
    )
  }
  let locationId = b.location_id || null
  if (!locationId) {
    if (userLocationIds.length === 1) {
      locationId = userLocationIds[0]
    } else {
      return NextResponse.json(
        { success: false, error: 'You are assigned to multiple locations — please specify which one this receipt is for.' },
        { status: 400 }
      )
    }
  }
  if (!userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'You are not assigned to that location.' }, { status: 403 })
  }

  // Only paths shaped by upload-sign AND inside this submitter's own
  // folder — a client-supplied path must not reach other objects.
  if (!isCardReceiptPath(b.receipt_path, user.id)) {
    return NextResponse.json({ success: false, error: 'Invalid receipt_path.' }, { status: 400 })
  }

  const db = createServerClient()

  // Verify the direct-to-storage object: it must exist and actually be
  // one of the accepted receipt types (the signed upload bypassed the
  // API, so re-check the real bytes). Delete anything that fails.
  // (Storage builders are thenables with no .catch — two-arg .then.)
  const { data: blob, error: dlErr } = await db.storage
    .from(CARD_RECEIPTS_BUCKET)
    .download(b.receipt_path)
  if (dlErr || !blob) {
    return NextResponse.json(
      { success: false, error: 'Uploaded receipt not found in storage — try the upload again.' },
      { status: 404 }
    )
  }
  const bytes = Buffer.from(await blob.arrayBuffer())
  if (bytes.length > MAX_RECEIPT_BYTES) {
    await db.storage.from(CARD_RECEIPTS_BUCKET).remove([b.receipt_path]).then(() => {}, () => {})
    return NextResponse.json({ success: false, error: 'File must be 10 MB or less.' }, { status: 400 })
  }
  const sniffed = sniffReceiptMime(bytes)
  if (!sniffed) {
    await db.storage.from(CARD_RECEIPTS_BUCKET).remove([b.receipt_path]).then(() => {}, () => {})
    return NextResponse.json({ success: false, error: 'Only a PDF or photo (JPG, PNG, HEIC) is accepted.' }, { status: 400 })
  }

  // Insert the intake record — just the photo + optional context. The
  // financial fields (amount/merchant/date/VAT) are filled later by the
  // bookkeeper's Analyse in /invoices (mig 267 made them nullable).
  const { data, error } = await db
    .from('card_receipts')
    .insert({
      location_id: locationId,
      submitter_id: user.id,
      card_last4: b.card_last4 || null,
      notes: (b.notes && String(b.notes).trim()) || null,
      receipt_path: b.receipt_path,
      receipt_size_bytes: bytes.length,
      receipt_mime_type: sniffed,
      status: 'submitted',
    })
    .select()
    .single()

  if (error) {
    await db.storage.from(CARD_RECEIPTS_BUCKET).remove([b.receipt_path]).then(() => {}, () => {})
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Auto-enqueue into the bookkeeper's invoices_queue (the emailed-invoice
  // path). If this fails the submission hasn't really happened — roll the
  // intake row + object back so the submitter can cleanly retry, rather
  // than orphaning a receipt that never reaches accounts.
  const enq = await enqueueFromCardReceipt(data.id)
  if (!enq.ok) {
    logWarn('card-receipt-submit', 'enqueue failed', { err: enq.error, receiptId: data.id })
    await db.from('card_receipts').delete().eq('id', data.id).then(() => {}, () => {})
    await db.storage.from(CARD_RECEIPTS_BUCKET).remove([b.receipt_path]).then(() => {}, () => {})
    return NextResponse.json(
      { success: false, error: 'Could not file the receipt with accounts — please try again.' },
      { status: 502 }
    )
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}

// ── GET: the caller's own submitted receipts ──────────────────────
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const db = createServerClient()
  const { data, error } = await db
    .from('card_receipts')
    .select(`
      id, status, card_last4, notes, submitted_at,
      location:location_id ( id, name )
    `)
    .eq('submitter_id', user.id)
    .order('submitted_at', { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
