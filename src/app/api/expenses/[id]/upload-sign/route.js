// POST /api/expenses/[id]/upload-sign
//
// MOBILE-UPLOAD.1 — step 1 of the receipt upload.
//
// The phone used to POST the receipt bytes as a multipart part of
// POST /api/expenses/[id]/items. That has not reached the server since the
// Expo SDK 57 upgrade (26 Jul 2026): the fetch rejects on the device, so
// there is no request and nothing to log — the last receipt to land in
// this bucket was 15 Jul. It was capped either way, since Vercel refuses a
// serverless request body over ~4.5 MB with a plain-text 413 before the
// route runs, which made the advertised 10 MB receipt unpostable.
//
// So the bytes bypass the API:
//   1. This route validates the prospective file, checks the claim is the
//      caller's and still a draft, mints the storage path and returns a
//      Supabase signed-upload token for the PRIVATE bucket.
//   2. The device uploads straight to Storage with that token.
//   3. POST /api/expenses/[id]/items (JSON mode) verifies the object and
//      inserts the item row carrying its path.
//
// Same gate as the items route: submitter-only, draft claims only.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
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

  let body
  try { body = await request.json() }
  catch { return NextResponse.json({ success: false, error: 'Expected a JSON body.' }, { status: 400 }) }

  // `files` is the shared upload client's wire shape (lib/upload-slots.js);
  // `photos` is the name its first caller used and is still accepted.
  const requested = Array.isArray(body?.files) ? body.files
    : Array.isArray(body?.photos) ? body.photos
    : []
  if (requested.length !== 1) {
    return NextResponse.json(
      { success: false, error: 'Exactly one receipt per item.', code: 'one_receipt' },
      { status: 400 }
    )
  }

  const [file] = requested
  const size = Number(file?.size)
  const mime = String(file?.mime || '').toLowerCase()
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ success: false, error: 'The receipt is empty or unreadable.', code: 'receipt_empty' }, { status: 400 })
  }
  if (size > RECEIPT_MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `Receipt too large (max ${(RECEIPT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
      code: 'receipt_too_large',
    }, { status: 400 })
  }
  if (!RECEIPT_ACCEPTED_MIMES.includes(mime)) {
    return NextResponse.json({
      success: false,
      error: `Receipt type ${mime || 'unknown'} not accepted. Use PDF or a phone-camera image (PNG / JPEG / HEIC / WebP).`,
      code: 'receipt_bad_type',
    }, { status: 400 })
  }

  // The item row does not exist yet, so the path is namespaced by an upload
  // draft id. Nothing reads the id back out of a receipt path.
  const path = buildReceiptPath({
    profileId: user.id,
    claimId,
    itemId: crypto.randomUUID(),
    filename: file?.file_name || 'receipt',
  })

  const { data, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(path)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not create upload URL: ${error?.message || 'no token returned'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, slots: [{ path, token: data.token }] })
}
