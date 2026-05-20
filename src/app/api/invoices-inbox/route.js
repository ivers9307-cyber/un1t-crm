// INVOICES.1 — collection endpoints for the inbound_invoices inbox.
//
// GET  /api/invoices-inbox        — list (role-scoped). master sees
//                                   every location; owner sees their
//                                   own. No 'self' tier — invoices
//                                   belong to the business not a
//                                   submitter.
// POST /api/invoices-inbox        — direct upload from the inbox UI
//                                   (manual ingest alternative to the
//                                   Postmark webhook). Same multipart
//                                   FormData shape the existing
//                                   contractor-invoices upload uses.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import {
  INBOUND_INVOICE_SUPPORTED_MIME,
  inboundInvoiceStoragePath,
  safeInboundFilename,
} from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB — bigger than a typical PDF; smaller than the Postmark inbound cap.

// Helper — returns the set of location_ids the user can view inbox
// rows for. master returns null (= unrestricted).
function inboxScope(user) {
  if (!user) return { allowed: false }
  if (user.role === 'master' || user.profileRole === 'master') {
    return { allowed: true, ownerLocations: null }
  }
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)
  if (ownerLocations.length === 0) return { allowed: false }
  return { allowed: true, ownerLocations }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const scope = inboxScope(user)
  if (!scope.allowed) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get('status')
  const locationFilter = searchParams.get('location_id')
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const db = createServerClient()

  let query = db
    .from('invoices_queue')
    .select(`
      id, location_id,
      sender_email, subject,
      attachment_filename, attachment_size_bytes, attachment_mime_type,
      status, received_at,
      quality_reviewed_at, quality_reviewed_by,
      extracted_at, extraction_confidence, extraction_error,
      data_reviewed_at, data_reviewed_by,
      forwarded_at, rejected_at,
      reject_reason, rejected_stage,
      extracted_fields,
      xero_email_message_id, xero_synced_at, xero_error,
      created_at,
      location:location_id ( id, name ),
      quality_reviewer:quality_reviewed_by ( id, full_name ),
      data_reviewer:data_reviewed_by ( id, full_name )
    `)
    .order('received_at', { ascending: false })
    .limit(limit)

  if (scope.ownerLocations) {
    query = query.in('location_id', scope.ownerLocations)
  }
  if (locationFilter) {
    // Re-apply explicit filter — also blocks an owner trying to look
    // at a location they don't own.
    query = query.eq('location_id', locationFilter)
  }
  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length > 0) query = query.in('status', statuses)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

const UploadBodySchema = z.object({
  location_id: uuidLike,
  sender_email: z.string().email().max(320).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const scope = inboxScope(user)
  if (!scope.allowed) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  let form
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Expected multipart/form-data.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return NextResponse.json({ success: false, error: 'Missing file.' }, { status: 400 })
  }
  if (!INBOUND_INVOICE_SUPPORTED_MIME.has(file.type)) {
    return NextResponse.json({
      success: false,
      error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, GIF, WebP.`,
    }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ success: false, error: 'File too large (max 25 MB).' }, { status: 413 })
  }

  const parsed = UploadBodySchema.safeParse({
    location_id: form.get('location_id'),
    sender_email: form.get('sender_email') || null,
    subject: form.get('subject') || null,
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, sender_email, subject } = parsed.data

  // Owner can only post for their own locations.
  if (scope.ownerLocations && !scope.ownerLocations.includes(location_id)) {
    return NextResponse.json({ success: false, error: 'Forbidden for this location.' }, { status: 403 })
  }

  const db = createServerClient()

  const ab = await file.arrayBuffer()
  const bytes = Buffer.from(ab)
  const filename = safeInboundFilename(file.name) || 'upload'

  // Insert first, get an id, then upload — same pattern as the webhook.
  const { data: row, error: insErr } = await db
    .from('invoices_queue')
    .insert({
      location_id,
      sender_email: sender_email || null,
      subject: subject || null,
      attachment_filename: filename,
      attachment_size_bytes: bytes.length,
      attachment_mime_type: file.type,
      status: 'received',
      source_type: 'supplier_email',
      attachment_bucket: STORAGE_BUCKET,
    })
    .select('id, location_id, status, created_at')
    .single()
  if (insErr || !row) {
    return NextResponse.json({ success: false, error: insErr?.message || 'insert_failed' }, { status: 500 })
  }

  const storagePath = inboundInvoiceStoragePath({
    locationId: location_id,
    invoiceId: row.id,
    safeFilename: filename,
  })
  const { error: upErr } = await db.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: false })
  if (upErr) {
    await db.from('invoices_queue').delete().eq('id', row.id)
    return NextResponse.json({ success: false, error: `Upload failed: ${upErr.message}` }, { status: 500 })
  }

  const { error: updErr } = await db
    .from('invoices_queue')
    .update({ attachment_path: storagePath })
    .eq('id', row.id)
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { ...row, attachment_path: storagePath } }, { status: 201 })
}
