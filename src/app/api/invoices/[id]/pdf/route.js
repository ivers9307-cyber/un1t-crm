// GET /api/invoices/[id]/pdf
//
// Returns a 5-minute signed URL for the invoice PDF in the private
// contractor-invoices bucket. Self/owner/master gates as for the
// detail route — same scoping logic.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

const STORAGE_BUCKET = 'contractor-invoices'
const SIGNED_URL_TTL_SECONDS = 300

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()

  const { data: inv, error } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, location_id, pdf_path')
    .eq('id', params.id)
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
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const { data: signed, error: sErr } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(inv.pdf_path, SIGNED_URL_TTL_SECONDS)
  if (sErr || !signed?.signedUrl) {
    return NextResponse.json(
      { success: false, error: `Could not sign URL: ${sErr?.message || 'unknown'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS })
}
