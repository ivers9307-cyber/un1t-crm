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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import {
  periodForMonth, buildPdfPath,
} from '@/lib/contractor-invoices'

export const runtime = 'nodejs'

const STORAGE_BUCKET = 'contractor-invoices'
const MAX_PDF_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_MIME = ['application/pdf']

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

  const form = await request.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ success: false, error: 'Expected multipart/form-data body.' }, { status: 400 })
  }

  const monthKey = String(form.get('month') || '').trim()
  const amountStr = String(form.get('amount') || '').trim()
  const invoiceNumber = String(form.get('invoice_number') || '').trim() || null
  const notes = String(form.get('notes') || '').trim() || null
  const locationIdRaw = String(form.get('location_id') || '').trim() || null
  const file = form.get('pdf')

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

  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'PDF attachment is required.' }, { status: 400 })
  }
  if (!ALLOWED_MIME.includes(file.type)) {
    return NextResponse.json({ success: false, error: 'Only PDF files are accepted.' }, { status: 400 })
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ success: false, error: 'PDF must be 10 MB or less.' }, { status: 400 })
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

  // Upload PDF.
  const pdfPath = buildPdfPath({
    contractorId: user.id,
    periodStart: period.period_start,
    originalFilename: file.name,
  })
  const ab = await file.arrayBuffer()
  const { error: upErr } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(pdfPath, Buffer.from(ab), {
      contentType: 'application/pdf',
      upsert: false,
    })
  if (upErr) {
    return NextResponse.json({ success: false, error: `Upload failed: ${upErr.message}` }, { status: 500 })
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
      pdf_size_bytes: file.size,
      notes,
      status: 'submitted',
    })
    .select()
    .single()

  if (error) {
    // Best-effort orphan cleanup if the DB rejected.
    await db.storage.from(STORAGE_BUCKET).remove([pdfPath]).catch(() => {})
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

  // Scope.
  if (user.role === 'master') {
    // No additional filter.
  } else if (isOwnerOrMaster(user)) {
    // Owner — limit to locations they own.
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (ownerLocations.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }
    query = query.in('location_id', ownerLocations)
  } else {
    // Everyone else — only their own.
    query = query.eq('contractor_id', user.id)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
