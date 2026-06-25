// GET /api/cars/[id]/xero-invoice-pdf
//
// Returns a 5-minute signed URL for the Xero invoice PDF we saved
// at issue time. Mirrors the existing /documents/[id] proxy pattern
// — keeps the bucket private, avoids leaking the storage path.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'car-documents'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car, error: loadErr } = await db
    .from('cars')
    .select('id, location_id, xero_invoice_pdf_path')
    .eq('id', params.id)
    .single()
  if (loadErr || !car) {
    return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  if (!car.xero_invoice_pdf_path) {
    return NextResponse.json({ success: false, error: 'No invoice PDF saved for this car.' }, { status: 404 })
  }

  const { data: signed, error: signErr } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(car.xero_invoice_pdf_path, 60 * 5)
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ success: false, error: signErr?.message || 'Could not sign URL' }, { status: 500 })
  }
  return NextResponse.json({ success: true, url: signed.signedUrl })
}
