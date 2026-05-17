// /api/cars/[id]/documents/[docId] — delete + signed-URL fetch.
//
// GET returns a short-lived signed URL the browser can use to
// download the original file from the private bucket. We don't
// stream through the API to keep memory usage flat for large PDFs.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'

async function loadDocAndCheckAccess(db, user, carId, docId) {
  const { data: doc } = await db.from('car_documents')
    .select('*, cars!inner(location_id)')
    .eq('id', docId)
    .eq('car_id', carId)
    .single()
  if (!doc) return { error: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  const guard = assertLocationAccess(user, doc.cars.location_id)
  if (guard) return { error: guard }
  return { doc }
}

// GET — returns a 1-hour signed URL the browser can use to fetch
// the file directly from Supabase Storage.
export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { doc, error } = await loadDocAndCheckAccess(db, user, params.id, params.docId)
  if (error) return error

  const { data, error: signErr } = await db.storage
    .from('car-documents')
    .createSignedUrl(doc.storage_path, 60 * 60)  // 1 hour
  if (signErr) {
    return NextResponse.json({ success: false, error: signErr.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { url: data.signedUrl, filename: doc.filename } })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { doc, error } = await loadDocAndCheckAccess(db, user, params.id, params.docId)
  if (error) return error

  // Best-effort: remove the storage object first, then the row. If
  // storage fails we still drop the row — better to have an orphaned
  // file than a broken database reference.
  await db.storage.from('car-documents').remove([doc.storage_path]).catch(() => {})
  const { error: delErr } = await db.from('car_documents').delete().eq('id', doc.id)
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
