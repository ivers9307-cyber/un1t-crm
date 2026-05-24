// SUPPLIER-MEMORY.1 — GET /api/locations/[id]/xero/supplier-default
//
// Returns the remembered coding (Xero account + category) for one
// supplier at this location, so the /invoices review screen can
// pre-fill the account picker the moment the operator picks a
// supplier by hand — covering the case where extraction's name
// auto-match missed (e.g. the invoice spells the supplier slightly
// differently from the Xero contact).
//
// Query: ?xero_contact_id=<id>  (required)
// Returns: { success, default: { account_code, xero_account_id, category } | null }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getSupplierDefault } from '@/lib/invoices-queue/supplier-defaults'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Location membership — same guard the sibling xero read routes use.
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const xeroContactId = new URL(request.url).searchParams.get('xero_contact_id')
  if (!xeroContactId) {
    return NextResponse.json({ success: false, error: 'xero_contact_id required' }, { status: 400 })
  }

  const db = createServerClient()
  const def = await getSupplierDefault(db, locationId, xeroContactId)

  return NextResponse.json({
    success: true,
    default: def
      ? {
          account_code: def.default_account_code,
          xero_account_id: def.default_xero_account_id,
          category: def.default_category,
        }
      : null,
  })
}
