// POST /api/cars/[id]/documents/[docId]/send-to-xero
//
// Forwards a single car_documents row to the org's Xero bills email
// address (the per-org email-in for Bills to pay → Create bill from
// email). PDFs sent there are auto-OCR'd by Xero and dropped into
// the Bills drafts queue without any user-side toggle.
//
// Persists xero_sent_at + xero_file_id (= Postmark message id) on
// the row so the UI can flip to "Sent" and completionGaps() can
// require this for required document types.
//
// Why email not Files API: see comment at the top of
// src/lib/xero/bills-email.js — the Files Inbox path requires a
// per-org "Convert files to bills" Xero setting; email-to-bills
// works on every Xero org by default.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendCarDocumentBillEmail } from '@/lib/xero/bills-email'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
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
    const result = await sendCarDocumentBillEmail(params.docId)

    // xero_file_id reused as the Postmark message id — it's the
    // strongest reference we have to the in-flight email. Schema
    // never required it to actually be a Xero-side id, just a
    // marker that the doc has been forwarded successfully.
    const { data: updated, error: upErr } = await db
      .from('car_documents')
      .update({
        xero_file_id: result.messageId,
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
        error: `Email sent (Postmark id ${result.messageId}) but DB update failed: ${upErr.message}`,
        result,
      }, { status: 500 })
    }

    return NextResponse.json({ success: true, document: updated, result })
  } catch (e) {
    await db.from('car_documents').update({
      xero_send_error: e.message || 'Send failed',
    }).eq('id', params.docId)

    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({ success: false, error: e.message || 'Send failed' }, { status })
  }
}
