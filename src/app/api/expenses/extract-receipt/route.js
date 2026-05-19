// POST /api/expenses/extract-receipt
//
// FTE-EXPENSES.3 — Claude Vision OCR for an expense receipt.
//
// Multipart body: just one field, `receipt` = the file.
// Response: { success: true, fields: {...}, confidence: '...' }
//        or { success: false, error: '...', raw_response?: '...' }
//
// Stateless — does NOT persist anything. The client uses the
// returned fields to pre-fill the add-item form; the operator
// reviews + adjusts + commits via POST /api/expenses/[id]/items
// which uploads the file *as record*. Splitting OCR from save means:
//   - The file is held only on the client until the operator
//     confirms; Storage never sees a "rejected" receipt
//   - If OCR fails, the operator can still manually fill the form
//     and submit with the file
//   - Re-running OCR (e.g. operator picked a clearer photo) is just
//     a second POST, no DB cleanup needed
//
// Authorisation: any signed-in user. The endpoint reveals nothing
// sensitive — it OCRs a file the caller already has in hand. We
// don't tie it to a specific claim because the operator hasn't
// committed yet; the actual add-item POST is the gated operation.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { extractReceiptFields } from '@/lib/expense-receipt-extraction'
import { RECEIPT_ACCEPTED_MIMES, RECEIPT_MAX_BYTES } from '@/lib/fte-expenses'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vision on a 1-2MB phone photo typically lands in 15-25s. Allow
// up to 60s so cold-start + a slow upload still completes.
export const maxDuration = 60

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Mirror the FTE gate from the create-claim route so contractors
  // can't run OCR via this endpoint either. Approvers (master/owner)
  // can — useful if they're reviewing on behalf of a staff member.
  const isFte = user.employment_type === 'fte'
  const isApprover = user.role === 'master' || user.role === 'owner'
  if (!isFte && !isApprover) {
    return NextResponse.json({
      success: false,
      error: 'Expense OCR is for FTE staff (and their approvers).',
    }, { status: 403 })
  }

  let form
  try { form = await request.formData() }
  catch {
    return NextResponse.json({ success: false, error: 'Expected multipart/form-data.' }, { status: 400 })
  }
  const file = form.get('receipt')
  if (!file || typeof file !== 'object' || !file.size) {
    return NextResponse.json({ success: false, error: 'Missing receipt file.' }, { status: 400 })
  }
  if (file.size > RECEIPT_MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `Receipt too large for OCR (max ${(RECEIPT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
    }, { status: 400 })
  }
  const mime = file.type || 'application/octet-stream'
  if (!RECEIPT_ACCEPTED_MIMES.includes(mime)) {
    return NextResponse.json({
      success: false,
      error: `Receipt type ${mime} not accepted. Use PDF or a phone-camera image (PNG / JPEG / WebP).`,
    }, { status: 400 })
  }

  const ab = await file.arrayBuffer()
  const result = await extractReceiptFields(Buffer.from(ab), mime)
  if (!result.ok) {
    return NextResponse.json({
      success: false,
      error: result.error,
      raw_response: result.raw_response,
    }, { status: 422 })
  }
  return NextResponse.json({
    success: true,
    fields: result.fields,
    confidence: result.fields.confidence,
  })
}
