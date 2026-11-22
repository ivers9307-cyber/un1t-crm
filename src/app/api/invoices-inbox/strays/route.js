// GET /api/invoices-inbox/strays — inbound invoice emails that matched no
// studio (INVOICEPREP.1). Masters only: the table holds mail for every
// studio and is closed to client sessions, so only this service-role read
// can see it.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 90
const MAX_ROWS = 50

export const GET = withAuth({ permission: null, location: false, master: true, forbiddenMessage: 'Master only' }, async ({ db }) => {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString()
  const { data, error } = await db
    .from('invoice_inbound_strays')
    .select('id, to_address, from_address, subject, reason, slug, received_at')
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) {
    logError('invoices-inbox', 'unmatched emails not read', { code: error.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load unmatched emails.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data || [] })
})
