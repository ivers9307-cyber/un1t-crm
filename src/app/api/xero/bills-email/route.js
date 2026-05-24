// POST /api/xero/bills-email
// Body: { location_id, bills_email_address }
//
// Stores the per-org Xero bills email-in address on the connection
// row. Validated as an email; null clears it.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

const Body = z.object({
  location_id: z.string().uuid(),
  bills_email_address: z.string().email().max(320).nullable(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  // Membership check — only locations the user belongs to.
  const userLocationIds = (user.locations || []).map(l => l.id)
  if (!userLocationIds.includes(parsed.data.location_id)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db
    .from('xero_connections')
    .update({ bills_email_address: parsed.data.bills_email_address })
    .eq('location_id', parsed.data.location_id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
