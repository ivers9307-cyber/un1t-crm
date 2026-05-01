// POST /api/cars/[id]/documents/[docId]/send-to-xero
//
// Forwards a single car_documents row to the Xero Files Inbox.
// Xero's auto-bill OCR turns the file into a draft Bill in
// Business → Bills to pay → Draft, automatically extracting the
// supplier, line items and amount.
//
// Persists xero_file_id + xero_sent_at on the row so the UI can
// flip to "Sent · pending OCR" and the completionGaps() check can
// require this for required document types.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendCarDocumentToXero } from '@/lib/xero/files'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  // IDOR guard — make sure this document belongs to the car in the
  // path AND the user has access to that car's location.
  const { data: doc, error: loadErr } = await db
    .from('car_documents')
    .select('id, car_id, cars!inner(id, location_id)')
    .eq('id', params.docId)
    .single()
  if (loadErr || !doc) {
    return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 })
  }
  if (doc.car_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Document does not belong to this car' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, doc.cars.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  try {
    const result = await sendCarDocumentToXero(params.docId)

    // Record the success even if the document had been forwarded
    // before — refresh the timestamp so the UI shows recency.
    const { data: updated, error: upErr } = await db
      .from('car_documents')
      .update({
        xero_file_id: result.xeroFileId,
        xero_sent_at: new Date().toISOString(),
        xero_sent_by: user.id,
        xero_send_error: null,
      })
      .eq('id', params.docId)
      .select()
      .single()

    if (upErr) {
      return NextResponse.json({
        success: false,
        error: `Sent to Xero (file id ${result.xeroFileId}) but DB update failed: ${upErr.message}`,
        result,
      }, { status: 500 })
    }

    return NextResponse.json({ success: true, document: updated, result })
  } catch (e) {
    // Persist the failure so the UI can show what went wrong.
    await db.from('car_documents').update({
      xero_send_error: e.message || 'Xero error',
    }).eq('id', params.docId)

    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({ success: false, error: e.message || 'Xero error' }, { status })
  }
}
