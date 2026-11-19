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
import { withAuth } from '@/lib/with-auth'
import { getSupplierDefault } from '@/lib/invoices-queue/supplier-defaults'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth({ permission: null, location: 'param' }, async ({ request, db, locationId }) => {
  const xeroContactId = new URL(request.url).searchParams.get('xero_contact_id')
  if (!xeroContactId) {
    return NextResponse.json({ success: false, error: 'xero_contact_id required' }, { status: 400 })
  }

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
})
