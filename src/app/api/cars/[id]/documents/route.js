// /api/cars/[id]/documents — multipart upload of an invoice or
// supporting image. Stored in the private 'car-documents' Supabase
// bucket; access goes only through this API which uses the service
// role client (RLS doesn't apply to that path, but we re-check
// location ownership manually before returning anything).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { ALL_DOCUMENT_TYPES } from '@/lib/cars'

export const runtime = 'nodejs'

const VALID_TYPES = new Set(ALL_DOCUMENT_TYPES.map(t => t.key))
const MAX_BYTES = 25 * 1024 * 1024  // 25 MB

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car } = await db.from('cars').select('id, location_id').eq('id', params.id).single()
  if (!car) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return guard

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
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ success: false, error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, { status: 400 })
  }

  // Upload to storage. Path includes car_id so files are grouped.
  // Filename gets a random suffix so collisions don't overwrite an
  // existing doc when the operator re-uploads with the same name.
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : ''
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const storagePath = `${car.id}/${docType}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext.startsWith('.' + safeName.split('.').pop()) ? '' : ext}`

  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadErr } = await db.storage
    .from('car-documents')
    .upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
  if (uploadErr) {
    return NextResponse.json({ success: false, error: `Upload failed: ${uploadErr.message}` }, { status: 500 })
  }

  const { data: doc, error: insertErr } = await db.from('car_documents').insert({
    car_id: car.id,
    doc_type: docType,
    storage_path: storagePath,
    filename: file.name,
    mime_type: file.type || null,
    size_bytes: file.size,
    uploaded_by: user.id,
    notes,
  }).select().single()

  if (insertErr) {
    // Roll back the storage upload so we don't leak orphan files.
    await db.storage.from('car-documents').remove([storagePath]).catch(() => {})
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: doc }, { status: 201 })
}
