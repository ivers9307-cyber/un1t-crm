// POST /api/cars/[id]/documents/sign
//
// CARDOCUPLOAD.1 (C124) — step 1 of the web picker's car-document upload
// (the flow is in src/lib/car-document-upload.js). Vercel refuses a
// multipart body over ~4.5 MB before POST /api/cars/[id]/documents runs, so
// the browser now puts the bytes straight into the private 'car-documents'
// bucket against the slot this route mints. The server picks the path (the
// car, the doc type, a UUID), so a caller cannot choose where the bytes
// land, and the token authorises exactly that one path (the bucket has no
// client policy, mig 403).
//
// The declared file is judged by the multipart route's rules here, to save a
// pointless upload, and the type to upload AS is decided here too: the
// bucket's allowed_mime_types applies to a signed upload, so an unlabelled
// file (judged by `head`, its first bytes, base64) or a legacy alias must
// reach Storage under its canonical listed type. …/finalise re-checks what
// Storage actually holds.
//
// Body: { doc_type, file_name, mime, size, head? }
// → { success: true, path, token, content_type }

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { ALL_DOCUMENT_TYPES } from '@/lib/cars'
import { carDocumentsGate } from '@/lib/car-documents-gate'
import { sniffMimeFromBytes } from '@/lib/invoice-extraction'
import { resolveCarDocumentType, sniffCarDocumentHeif } from '@/lib/car-document-media'
import {
  buildCarDocumentUploadPath, checkCarDocumentSize, CAR_DOCUMENT_TYPE_ERROR, CAR_DOCUMENT_HEAD_BYTES,
} from '@/lib/car-document-upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_TYPES = new Set(ALL_DOCUMENT_TYPES.map(t => t.key))

const CarDocumentSignSchema = z.object({
  doc_type: z.string().min(1).max(64),
  file_name: z.string().min(1).max(300),
  mime: z.string().max(200).default(''),
  size: z.number().int(),
  // base64 of the file's first bytes; only an unlabelled file needs it.
  head: z.string().max(Math.ceil(CAR_DOCUMENT_HEAD_BYTES / 3) * 4).optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const gate = await carDocumentsGate(user, db, params.id)
  if (gate.response) return gate.response
  const { car } = gate

  const validation = await validateBody(request, CarDocumentSignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (!VALID_TYPES.has(body.doc_type)) {
    return NextResponse.json({ success: false, error: 'Invalid doc_type' }, { status: 400 })
  }
  const sizeError = checkCarDocumentSize(body.size)
  if (sizeError) return NextResponse.json({ success: false, error: sizeError }, { status: 400 })

  const head = body.head ? Buffer.from(body.head, 'base64') : null
  const sniffed = head ? (sniffMimeFromBytes(head) || sniffCarDocumentHeif(head)) : null
  const contentType = resolveCarDocumentType(body.mime, sniffed)
  if (!contentType) return NextResponse.json({ success: false, error: CAR_DOCUMENT_TYPE_ERROR }, { status: 400 })

  const path = buildCarDocumentUploadPath({ carId: car.id, docType: body.doc_type, contentType, id: randomUUID() })
  const { data, error } = await db.storage.from('car-documents').createSignedUploadUrl(path)
  if (error || !data?.token) {
    return NextResponse.json(
      { success: false, error: `Could not start the upload: ${error?.message || 'no token returned'}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, path, token: data.token, content_type: contentType })
}
