// /api/cars/[id]/documents — multipart upload of an invoice or
// supporting image. CARDOCUPLOAD.1 (C124): the web picker no longer posts
// here (Vercel refuses a body over ~4.5 MB before this runs); it uploads
// through …/documents/sign + …/documents/finalise. This stays for other
// callers and keeps the same rules. Stored in the private 'car-documents' Supabase
// bucket; access goes only through this API which uses the service
// role client (RLS doesn't apply to that path, but we re-check
// location ownership manually before returning anything).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { ALL_DOCUMENT_TYPES } from '@/lib/cars'
import { carDocumentsGate } from '@/lib/car-documents-gate'
import { recordCarDocument } from '@/lib/car-document-record'
import { sniffMimeFromBytes } from '@/lib/invoice-extraction'
import {
  CAR_DOCUMENT_MAX_BYTES, CAR_DOCUMENT_TYPES_LABEL, resolveCarDocumentType, sniffCarDocumentHeif,
} from '@/lib/car-document-media'

export const runtime = 'nodejs'

const VALID_TYPES = new Set(ALL_DOCUMENT_TYPES.map(t => t.key))

// withAuth only signs the caller in; carDocumentsGate keeps every other check
// in its order. CARDOCUPLOAD.1 — the gate is shared with …/documents/sign and
// …/finalise.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const gate = await carDocumentsGate(user, db, params?.id)
  if (gate.response) return gate.response
  const { car } = gate

  const formData = await request.formData()
  const file = formData.get('file')
  const docType = String(formData.get('doc_type') || '')
  const notes = formData.get('notes') ? String(formData.get('notes')) : null

  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'No file uploaded' }, { status: 400 })
  }
  if (!VALID_TYPES.has(docType)) {
    return NextResponse.json({ success: false, error: 'Invalid doc_type' }, { status: 400 })
  }
  if (file.size > CAR_DOCUMENT_MAX_BYTES) {
    return NextResponse.json({ success: false, error: `File too large (max ${CAR_DOCUMENT_MAX_BYTES / 1024 / 1024} MB)` }, { status: 400 })
  }

  // CARDOCBUCKET.1 — the same seven types the bucket accepts (mig 687), so a
  // refused file is a clear 400 here, not a Storage error. An unlabelled
  // file (no type, or application/octet-stream) is judged by its first bytes
  // (a .heic from Chrome/Firefox on Windows arrives with no type). A legacy
  // alias (image/jpg, application/x-pdf) is stored, and sent to Storage, as
  // its canonical type, which is what the bucket's allowed_mime_types checks.
  const buffer = Buffer.from(await file.arrayBuffer())
  const contentType = resolveCarDocumentType(file.type, sniffMimeFromBytes(buffer) || sniffCarDocumentHeif(buffer))
  if (!contentType) {
    return NextResponse.json({ success: false, error: `Unsupported file type (${CAR_DOCUMENT_TYPES_LABEL})` }, { status: 400 })
  }

  // Upload to storage. Path includes car_id so files are grouped.
  // Filename gets a random suffix so collisions don't overwrite an
  // existing doc when the operator re-uploads with the same name.
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : ''
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const storagePath = `${car.id}/${docType}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext.startsWith('.' + safeName.split('.').pop()) ? '' : ext}`

  const { error: uploadErr } = await db.storage
    .from('car-documents')
    .upload(storagePath, buffer, {
      contentType,
      upsert: false,
    })
  if (uploadErr) {
    logError('car-documents-upload', 'storage upload failed', { carId: car.id, err: uploadErr })
    return NextResponse.json({ success: false, error: 'Upload failed.' }, { status: 500 })
  }

  // CARDOCUPLOAD.1 — the row, the orphan rollback and the bookkeeper queue
  // (INVOICES-QUEUE.1) are shared with …/documents/finalise.
  const rec = await recordCarDocument(db, {
    car, docType, storagePath, filename: file.name, mimeType: contentType, sizeBytes: file.size, userId: user.id, notes,
  })
  if (!rec.ok) {
    // A conflict's text is the fixed CAR_DOCUMENT_ALREADY_SAVED; any other is database text.
    if (rec.conflict) return NextResponse.json({ success: false, error: rec.error }, { status: 409 })
    logError('car-documents-upload', 'document row failed', { carId: car.id, err: rec.error })
    return NextResponse.json({ success: false, error: 'Could not save the document.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: rec.doc, queue_warning: rec.queueWarning }, { status: 201 })
})
