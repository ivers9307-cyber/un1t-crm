// /api/invoices
//
//   POST  contractor submits a new invoice (multipart: pdf + fields)
//   GET   list — role-aware:
//           contractor → only their own
//           owner     → submissions at locations they own
//           master    → everything
//
// Storage: PDF lands in the private 'contractor-invoices' bucket
// at {contractor_id}/{period_start}-{rand}-{filename}.pdf. We hold
// the path on the row; clients fetch a signed URL via
// /api/invoices/[id]/pdf when they need to view.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import {
  periodForMonth, buildPdfPath, isContractorPdfPath,
  RECEIPT_MIME_TYPES, sniffReceiptMime,
} from '@/lib/contractor-invoices'

// JSON submit mode (INVOICE-UPLOAD.1): the PDF is already in storage via
// /api/invoices/upload-sign + a signed direct upload; the body carries a
// pointer instead of the bytes.
const JsonSubmitSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM'),
  amount: z.number().positive(),
  invoice_number: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.nullable().optional(),
  pdf_path: z.string().min(3).max(300),
  pdf_name: z.string().min(1).max(200),
})

export const runtime = 'nodejs'

const STORAGE_BUCKET = 'contractor-invoices'
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024 // 10 MB
// SPEND.P1 — an invoice may be a PDF or a phone photo of a paper receipt.
const ALLOWED_MIME = RECEIPT_MIME_TYPES

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

// ── POST: contractor submits an invoice ───────────────────────────
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Lock the submit endpoint to contractors only. FTEs and admin
  // roles never invoice through this surface, so a curl from any
  // other employment_type gets a 403 — defence in depth on top of
  // the UI hiding the form.
  if (user.employment_type !== 'contractor') {
    return NextResponse.json(
      {
        success: false,
        error: 'Only contractor accounts can submit invoices. If this is wrong, ask an owner to update your profile.',
      },
      { status: 403 }
    )
  }

  // Dual-mode input (INVOICE-UPLOAD.1). JSON = the direct-to-storage
  // flow: the PDF is ALREADY in the bucket via /api/invoices/upload-sign
  // + a signed upload, and the body carries only a pointer — Vercel caps
  // request bodies at ~4.5 MB, so a 10 MB PDF can't physically POST
  // through this route. Multipart = the legacy inline flow, kept so
  // older mobile builds (updated lazily via OTA) keep working for files
  // under the platform cap.
  const isJsonMode = (request.headers.get('content-type') || '').includes('application/json')
  let monthKey, amountStr, invoiceNumber, notes, locationIdRaw
  let file = null
  let jsonPdf = null
  if (isJsonMode) {
    const validation = await validateBody(request, JsonSubmitSchema)
    if (!validation.ok) return validation.response
    const b = validation.data
    monthKey = b.month
    amountStr = String(b.amount)
    invoiceNumber = String(b.invoice_number || '').trim() || null
    notes = String(b.notes || '').trim() || null
    locationIdRaw = b.location_id || null
    jsonPdf = { path: b.pdf_path, name: b.pdf_name }
  } else {
    const form = await request.formData().catch(() => null)
    if (!form) {
      return NextResponse.json({ success: false, error: 'Expected multipart/form-data body.' }, { status: 400 })
    }
    monthKey = String(form.get('month') || '').trim()
    amountStr = String(form.get('amount') || '').trim()
    invoiceNumber = String(form.get('invoice_number') || '').trim() || null
    notes = String(form.get('notes') || '').trim() || null
    locationIdRaw = String(form.get('location_id') || '').trim() || null
    file = form.get('pdf')
  }

  // Period validation.
  let period
  try {
    period = periodForMonth(monthKey)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 400 })
  }

  const amount = Number(amountStr)
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ success: false, error: 'Invoice amount must be a positive number.' }, { status: 400 })
  }

  if (!isJsonMode) {
    if (!file || typeof file === 'string') {
      return NextResponse.json({ success: false, error: 'A PDF or photo attachment is required.' }, { status: 400 })
    }
    if (!ALLOWED_MIME.includes(file.type)) {
      return NextResponse.json({ success: false, error: 'Only a PDF or photo (JPG, PNG, HEIC) is accepted.' }, { status: 400 })
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      return NextResponse.json({ success: false, error: 'File must be 10 MB or less.' }, { status: 400 })
    }
  }

  // Resolve location. If the contractor has exactly one assignment,
  // use that. Otherwise the form must specify which location they're
  // invoicing for.
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) {
    return NextResponse.json(
      { success: false, error: 'You are not assigned to any location — cannot submit an invoice.' },
      { status: 400 }
    )
  }
  let locationId = locationIdRaw
  if (!locationId) {
    if (userLocationIds.length === 1) {
      locationId = userLocationIds[0]
    } else {
      return NextResponse.json(
        { success: false, error: 'You are assigned to multiple locations — please specify which one this invoice is for.' },
        { status: 400 }
      )
    }
  }
  if (!userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'You are not assigned to that location.' }, { status: 403 })
  }

  const db = createServerClient()

  // Pre-check: existing active row blocks resubmit.
  const { data: existingActive } = await db
    .from('contractor_invoices')
    .select('id, status')
    .eq('contractor_id', user.id)
    .eq('period_start', period.period_start)
    .neq('status', 'declined')
    .maybeSingle()
  if (existingActive) {
    return NextResponse.json(
      {
        success: false,
        error: existingActive.status === 'approved'
          ? `An invoice for ${period.label} has already been approved.`
          : `You already have a submission pending review for ${period.label}.`,
      },
      { status: 409 }
    )
  }

  // PDF: verify the direct-to-storage object (JSON mode) or upload the
  // inline bytes (legacy multipart mode).
  let pdfPath
  let pdfSizeBytes
  if (isJsonMode) {
    // Only paths shaped by upload-sign AND inside this contractor's own
    // folder — a client-supplied path must not reach other objects.
    if (!isContractorPdfPath(jsonPdf.path, user.id)) {
      return NextResponse.json({ success: false, error: 'Invalid pdf_path.' }, { status: 400 })
    }
    const { data: blob, error: dlErr } = await db.storage
      .from(STORAGE_BUCKET)
      .download(jsonPdf.path)
    if (dlErr || !blob) {
      return NextResponse.json(
        { success: false, error: 'Uploaded PDF not found in storage — try the upload again.' },
        { status: 404 }
      )
    }
    const bytes = Buffer.from(await blob.arrayBuffer())
    // The signed upload bypassed this route, so re-enforce the gates on
    // the real bytes; delete anything that fails so the bucket doesn't
    // accumulate unusable objects. (Storage builders are thenables with
    // no .catch — two-arg .then per the repo lesson.)
    if (bytes.length > MAX_RECEIPT_BYTES) {
      await db.storage.from(STORAGE_BUCKET).remove([jsonPdf.path]).then(() => {}, () => {})
      return NextResponse.json({ success: false, error: 'File must be 10 MB or less.' }, { status: 400 })
    }
    // Magic-byte check: the stored object must actually be one of the
    // accepted receipt types (a wrong Content-Type header can't fool
    // this — sniffReceiptMime reads the real signature).
    if (!sniffReceiptMime(bytes)) {
      await db.storage.from(STORAGE_BUCKET).remove([jsonPdf.path]).then(() => {}, () => {})
      return NextResponse.json({ success: false, error: 'Only a PDF or photo (JPG, PNG, HEIC) is accepted.' }, { status: 400 })
    }
    pdfPath = jsonPdf.path
    pdfSizeBytes = bytes.length
  } else {
    pdfPath = buildPdfPath({
      contractorId: user.id,
      periodStart: period.period_start,
      originalFilename: file.name,
    })
    const ab = await file.arrayBuffer()
    const { error: upErr } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(pdfPath, Buffer.from(ab), {
        // file.type was already validated against RECEIPT_MIME_TYPES above;
        // store it so the signed URL serves the right Content-Type and the
        // reviewer's iframe / in-app browser renders it inline.
        contentType: file.type || 'application/pdf',
        upsert: false,
      })
    if (upErr) {
      return NextResponse.json({ success: false, error: `Upload failed: ${upErr.message}` }, { status: 500 })
    }
    pdfSizeBytes = file.size
  }

  // Insert the row.
  const { data, error } = await db
    .from('contractor_invoices')
    .insert({
      contractor_id: user.id,
      location_id: locationId,
      period_start: period.period_start,
      period_end: period.period_end,
      invoice_amount: amount,
      invoice_number: invoiceNumber,
      pdf_path: pdfPath,
      pdf_size_bytes: pdfSizeBytes,
      notes,
      status: 'submitted',
    })
    .select()
    .single()

  if (error) {
    // Best-effort orphan cleanup if the DB rejected.
    // Storage builders are thenables with NO .catch — the old
    // `.catch(() => {})` here threw a TypeError at runtime and turned a
    // clean insert-failure response into a 500 (repo lesson: two-arg
    // .then is the safe best-effort form).
    await db.storage.from(STORAGE_BUCKET).remove([pdfPath]).then(() => {}, () => {})
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
    .from('contractor_invoices')
    .select(`
      id, status, period_start, period_end, invoice_amount, invoice_number,
      submitted_at, reviewed_at, approved_at, decline_reason,
      xero_synced_at,
      contractor:contractor_id ( id, full_name, email, hourly_rate ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .order('submitted_at', { ascending: false })
    .limit(limit)

  if (statusFilter) query = query.eq('status', statusFilter)

  // Scope — ORG-ISOLATION: each location is its own business.
  //   • master / owner → active location only. Switch active to see
  //     another studio. (Master can still override via ?location_id
  //     query param below.)
  //   • everyone else → only their own invoices.
  if (isOwnerOrMaster(user)) {
    const isMaster = user.role === 'master'
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    const explicit = new URL(request.url).searchParams.get('location_id')
    const activeId = user.activeLocation?.id || null
    const target = explicit || activeId
    if (!target) return NextResponse.json({ success: true, data: [] })
    if (!isMaster && !ownerLocations.includes(target)) {
      return NextResponse.json({ success: false, error: 'Forbidden — not your location' }, { status: 403 })
    }
    query = query.eq('location_id', target)
  } else {
    // Everyone else — only their own.
    query = query.eq('contractor_id', user.id)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
