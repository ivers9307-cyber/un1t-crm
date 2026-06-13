// /api/card-receipts
//
//   POST  submit a company-card receipt (JSON; the receipt is already
//         in storage via /api/card-receipts/upload-sign + a signed
//         direct upload — the body carries a pointer).
//   GET   list — role-aware:
//           owner / master → the active location's queue (approver view)
//           everyone else  → only their own submissions
//
// Submission is gated by the `card_receipts` permission (card holders).
// The receipt file lives in the private 'company-card-receipts' bucket
// at {submitter_id}/{date}-{rand}-{filename}; the path is held on the
// row, clients fetch a signed URL via /api/card-receipts/[id]/receipt.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import {
  isCardReceiptPath, sniffReceiptMime, CARD_RECEIPTS_BUCKET, MAX_RECEIPT_BYTES,
} from '@/lib/card-receipts'

export const runtime = 'nodejs'

const SubmitSchema = z.object({
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  amount: z.number().positive(),
  vat_amount: z.number().min(0).nullable().optional(),
  merchant: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  card_last4: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.nullable().optional(),
  receipt_path: z.string().min(3).max(300),
  receipt_name: z.string().min(1).max(200),
})

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

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

  const amount = Number(b.amount)
  const vat = b.vat_amount == null ? 0 : Number(b.vat_amount)
  if (vat > amount) {
    return NextResponse.json({ success: false, error: 'VAT cannot exceed the total amount.' }, { status: 400 })
  }

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
  // API, so re-check the real bytes — a wrong Content-Type can't fool
  // sniffReceiptMime). Delete anything that fails so the bucket doesn't
  // accumulate unusable objects. (Storage builders are thenables with no
  // .catch — two-arg .then per the repo lesson.)
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

  const { data, error } = await db
    .from('card_receipts')
    .insert({
      location_id: locationId,
      submitter_id: user.id,
      purchase_date: b.purchase_date,
      amount,
      vat_amount: vat,
      merchant: (b.merchant && String(b.merchant).trim()) || null,
      description: (b.description && String(b.description).trim()) || null,
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
    // Best-effort orphan cleanup if the DB rejected.
    await db.storage.from(CARD_RECEIPTS_BUCKET).remove([b.receipt_path]).then(() => {}, () => {})
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}

// ── GET: role-aware list ──────────────────────────────────────────
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get('status') // optional
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const db = createServerClient()

  let query = db
    .from('card_receipts')
    .select(`
      id, status, purchase_date, amount, vat_amount, merchant, description,
      card_last4, submitted_at, reviewed_at, approved_at, declined_at,
      revoked_at, decline_reason, notes,
      submitter:submitter_id ( id, full_name, email ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .order('submitted_at', { ascending: false })
    .limit(limit)

  if (statusFilter) query = query.eq('status', statusFilter)

  // Scope — ORG-ISOLATION, mirrors /api/invoices:
  //   • owner / master → the active location queue (the approver view).
  //     Master can override via ?location_id.
  //   • everyone else → only their own submissions.
  if (isOwnerOrMaster(user)) {
    const isMaster = user.role === 'master'
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    const explicit = searchParams.get('location_id')
    const activeId = user.activeLocation?.id || null
    const target = explicit || activeId
    if (!target) return NextResponse.json({ success: true, data: [] })
    if (!isMaster && !ownerLocations.includes(target)) {
      return NextResponse.json({ success: false, error: 'Forbidden — not your location' }, { status: 403 })
    }
    query = query.eq('location_id', target)
  } else {
    query = query.eq('submitter_id', user.id)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
