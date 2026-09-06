// GET /api/host/contacts
//
// The host's OWN contact list (HOST-EMAIL.1): host_contacts membership joined
// to the contact's identity + host consent (host_contacts.marketing_consent) + mailbox flags, with
// `emailable` computed via isEmailable — the same predicate PR-C's send path
// uses, so what this shows is exactly who a campaign would reach.
// Tenancy: getCurrentHost() → fetchHostContactRows scopes every query
// .eq('host_id', session.host.id); a host can never read another host's list.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchHostContactRows } from '@/lib/host-contact-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  try {
    const rows = await fetchHostContactRows(db, session.host.id)
    return NextResponse.json({ success: true, data: rows })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
