// INVOICES.1 — shared helpers for /api/invoices-inbox/[id]/* routes.
//
// Pulls a row, runs the master/owner-at-location auth check, and
// surfaces the same NextResponse shape every transition route
// needs. Keeps the per-transition files tiny and consistent.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'

export const ROW_SELECT = `
  id, location_id, sender_email, subject, email_message_id,
  attachment_bucket, attachment_path, attachment_filename, attachment_size_bytes, attachment_mime_type,
  status, received_at,
  quality_reviewed_at, quality_reviewed_by,
  extracted_at, extraction_confidence, extraction_error,
  data_reviewed_at, data_reviewed_by,
  forwarded_at, rejected_at,
  reject_reason, rejected_stage,
  extracted_fields,
  xero_email_message_id, xero_bill_id, xero_bill_number, xero_deep_link_url,
  xero_synced_at, xero_error,
  xero_bill_status, xero_bill_paid_at, xero_bill_amount_paid, xero_bill_amount_due, xero_bill_status_synced_at,
  created_at, updated_at,
  location:location_id ( id, name ),
  quality_reviewer:quality_reviewed_by ( id, full_name ),
  data_reviewer:data_reviewed_by ( id, full_name )
`

/**
 * Returns { user, db, row } or { response } where response is the
 * NextResponse to return directly (401/403/404). Centralises the
 * "load row, check master-or-owner-at-location, return error
 * envelope" pattern.
 */
export async function loadInvoiceForUser(id) {
  const user = await getCurrentUser()
  if (!user) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }

  const db = createServerClient()
  const { data: row, error } = await db
    .from('invoices_queue')
    .select(ROW_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return { response: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  }
  if (!row) {
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }

  // Two gates layered here:
  //  • invoices_inbox permission at the row's location — makes the
  //    StaffForm toggle real (an opted-out owner is fully locked
  //    out, API included).
  //  • master-or-owner-at-location — approval AUTHORITY for the
  //    quality/data transitions stays a role decision (a manager
  //    granted invoices_inbox gets the view, not the sign-off).
  const isMaster = user.role === 'master' || user.profileRole === 'master'
  const ownsLocation = Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === row.location_id)
  const hasInboxPermission = hasPermissionForLocation(user, row.location_id, 'invoices_inbox')
  if (!hasInboxPermission || (!isMaster && !ownsLocation)) {
    // 404 (not 403) so a cross-org caller can't distinguish "exists elsewhere"
    // from "doesn't exist" — matches the not-found branch above. Covers every
    // invoices-inbox/[id]/* route via this shared loader.
    return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  }

  return { user, db, row }
}
