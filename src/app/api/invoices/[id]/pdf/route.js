// GET /api/invoices/[id]/pdf
//
// Returns a 5-minute signed URL for the invoice PDF in the private
// contractor-invoices bucket. Self/owner/master gates as for the
// detail route — same scoping logic.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

const STORAGE_BUCKET = 'contractor-invoices'
const SIGNED_URL_TTL_SECONDS = 300

// withAuth only signs the caller in; the self / owner-at-the-invoice's-studio /
// master checks stay below in their old order (404 on no access).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { data: inv, error } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, location_id, pdf_path')
    .eq('id', params?.id)
    .single()
  if (error || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  const isSelf = inv.contractor_id === user.id
  const isMaster = user.role === 'master'
  let isOwnerHere = false
  if (!isMaster && !isSelf) {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    isOwnerHere = ownerLocations.includes(inv.location_id)
    if (!isOwnerHere) {
      // 404 (not 403) so a non-owner can't tell this invoice exists.
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
    }
  }

  const { data: signed, error: sErr } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(inv.pdf_path, SIGNED_URL_TTL_SECONDS)
  if (sErr || !signed?.signedUrl) {
    logError('invoices', 'pdf url not signed', { invoiceId: inv.id, err: sErr || null })
    return NextResponse.json({ success: false, error: 'Could not open the PDF. Try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS })
})
