// POST /api/cars/[id]/documents/finalise
//
// CARDOCUPLOAD.1 (C124) — step 3 of the web picker's car-document upload
// (the flow is in src/lib/car-document-upload.js). The browser has put the
// bytes at a slot …/documents/sign minted; this records them. The path must
// be a slot for THIS car and doc type, and the size and type are read back
// from Storage, never taken from the caller. The multipart route's rules
// apply to what Storage holds: `mime` (the browser's File.type) plays the
// part of the multipart file's type, and when it is unlabelled the stored
// bytes are sniffed. The result must also be the Content-Type Storage holds
// the object under, which is what the document is served as later. An
// object that breaks a rule is removed.
//
// A good object becomes exactly the multipart route's car_documents row and
// bookkeeper-queue entry (src/lib/car-document-record.js), same 201 shape.
//
// Body: { doc_type, path, file_name, mime, notes? }
// → 201 { success: true, data: <car_documents row>, queue_warning? }

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { ALL_DOCUMENT_TYPES } from '@/lib/cars'
import { carDocumentsGate } from '@/lib/car-documents-gate'
import { recordCarDocument } from '@/lib/car-document-record'
import { sniffMimeFromBytes } from '@/lib/invoice-extraction'
import { resolveCarDocumentType, sniffCarDocumentHeif, isUnlabelledCarDocumentType } from '@/lib/car-document-media'
import {
  isCarDocumentUploadPath, checkCarDocumentSize, CAR_DOCUMENT_TYPE_ERROR, CAR_DOCUMENT_HEAD_BYTES,
} from '@/lib/car-document-upload'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_TYPES = new Set(ALL_DOCUMENT_TYPES.map(t => t.key))

const CarDocumentFinaliseSchema = z.object({
  doc_type: z.string().min(1).max(64),
  path: z.string().min(1).max(500),
  file_name: z.string().min(1).max(300),
  mime: z.string().max(200).default(''),
  notes: z.string().max(2000).nullable().optional(),
})

const MISMATCH_ERROR = "The uploaded file's type does not match. Pick it again."

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const gate = await carDocumentsGate(user, db, params.id)
  if (gate.response) return gate.response
  const { car } = gate

  const validation = await validateBody(request, CarDocumentFinaliseSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (!VALID_TYPES.has(body.doc_type)) {
    return NextResponse.json({ success: false, error: 'Invalid doc_type' }, { status: 400 })
  }
  if (!isCarDocumentUploadPath(body.path, car.id, body.doc_type)) {
    return NextResponse.json({ success: false, error: 'That is not an upload slot for this car.' }, { status: 400 })
  }

  // A slot is recorded once: a replayed finalise must not file a second
  // document (and a second bookkeeper-queue entry) for the same bytes.
  const { data: existing, error: existingErr } = await db.from('car_documents')
    .select('id').eq('car_id', car.id).eq('storage_path', body.path).limit(1)
  if (existingErr) {
    logWarn('car-documents-upload', 'duplicate check failed', { error: existingErr.message })
    return NextResponse.json({ success: false, error: `Could not check the upload: ${existingErr.message}` }, { status: 500 })
  }
  if (existing?.length) {
    return NextResponse.json({ success: false, error: 'This upload is already saved.' }, { status: 409 })
  }

  const bucket = db.storage.from('car-documents')
  const slash = body.path.lastIndexOf('/')
  const folder = body.path.slice(0, slash)
  const name = body.path.slice(slash + 1)
  const { data: listed, error: listErr } = await bucket.list(folder, { search: name })
  if (listErr) {
    logWarn('car-documents-upload', 'stored document read failed', { error: listErr.message })
    return NextResponse.json({ success: false, error: `Could not check the upload: ${listErr.message}` }, { status: 500 })
  }
  const hit = (listed || []).find((o) => o?.name === name)
  if (!hit) {
    return NextResponse.json({ success: false, error: 'The file did not finish uploading. Try again.' }, { status: 400 })
  }

  async function refuse(error, status = 400) {
    try {
      const { error: rmErr } = await bucket.remove([body.path])
      if (rmErr) logWarn('car-documents-upload', 'refused document not removed', { error: rmErr.message })
    } catch (e) {
      logWarn('car-documents-upload', 'refused document not removed', { error: e?.message })
    }
    return NextResponse.json({ success: false, error }, { status })
  }

  const size = Number(hit.metadata?.size)
  const sizeError = checkCarDocumentSize(size)
  if (sizeError) return refuse(sizeError)

  // The multipart route's type rule, on what Storage holds.
  let contentType = resolveCarDocumentType(body.mime, null)
  if (!contentType && isUnlabelledCarDocumentType(body.mime)) {
    const { data: blob, error: dlErr } = await bucket.download(body.path)
    if (dlErr || !blob) {
      logWarn('car-documents-upload', 'stored document bytes unreadable', { error: dlErr?.message })
      return refuse(`Could not check the upload: ${dlErr?.message || 'no data'}`, 500)
    }
    const head = Buffer.from(await blob.slice(0, CAR_DOCUMENT_HEAD_BYTES).arrayBuffer())
    contentType = resolveCarDocumentType(body.mime, sniffMimeFromBytes(head) || sniffCarDocumentHeif(head))
  }
  if (!contentType) return refuse(CAR_DOCUMENT_TYPE_ERROR)

  const storedType = String(hit.metadata?.mimetype || '').split(';')[0].trim().toLowerCase()
  if (storedType !== contentType) return refuse(MISMATCH_ERROR)

  const rec = await recordCarDocument(db, {
    car,
    docType: body.doc_type,
    storagePath: body.path,
    filename: body.file_name,
    mimeType: contentType,
    sizeBytes: size,
    userId: user.id,
    notes: body.notes ?? null,
  })
  if (!rec.ok) return NextResponse.json({ success: false, error: rec.error }, { status: 500 })

  return NextResponse.json({ success: true, data: rec.doc, queue_warning: rec.queueWarning }, { status: 201 })
}
