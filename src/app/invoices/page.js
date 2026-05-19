// INVOICES.1 — Dext-style email-in invoice inbox.
//
// Route lives at /invoices (top-level, not /schedule/* because this
// is a finance surface, not a scheduling one). The contractor
// invoice flow at /schedule/invoices is unrelated despite the
// similar naming — that's a single contractor's own claims; this
// is the operator inbox for ALL inbound supplier invoices.
//
// Access: master + owner-at-location only. Enforced server-side
// here AND in every /api/invoices-inbox route — sidebar visibility
// follows the same `invoices_inbox` permission key.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import InvoicesInbox from '@/components/InvoicesInbox'

export const dynamic = 'force-dynamic'

export default async function InvoicesInboxPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/invoices')

  const isMaster = user.profileRole === 'master' || user.role === 'master'
  const ownsAny = Object.values(user.rolesByLocation || {}).some((r) => r === 'owner')
  if (!isMaster && !ownsAny) redirect('/dashboard')

  // Locations + their forwarding-address slugs so the inbox header
  // can show the operator which email to use. Master sees all
  // locations; owner sees only their own.
  const db = createServerClient()
  let locations = []
  if (isMaster) {
    const { data } = await db
      .from('locations')
      .select('id, name, invoices_inbound_slug')
      .eq('active', true)
      .order('name')
    locations = data || []
  } else {
    const ownerLocationIds = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner')
      .map(([id]) => id)
    if (ownerLocationIds.length > 0) {
      const { data } = await db
        .from('locations')
        .select('id, name, invoices_inbound_slug')
        .in('id', ownerLocationIds)
        .order('name')
      locations = data || []
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-white">Invoices</h1>
        <p className="text-sm text-un1t-light mt-1">
          Forward supplier invoices to the per-location email address below. Each invoice gets a two-step review — quality, then extracted data — before forwarding to Xero.
        </p>
      </header>
      <InvoicesInbox locations={locations} isMaster={isMaster} />
    </div>
  )
}
