// INVOICES.1 — Dext-style email-in invoice inbox.
//
// Route lives at /invoices (top-level, not /schedule/* because this
// is a finance surface, not a scheduling one). The contractor
// invoice flow at /schedule/invoices is unrelated despite the
// similar naming — that's a single contractor's own claims; this
// is the operator inbox for ALL inbound supplier invoices.
//
// Access: the `invoices_inbox` permission (master + owner by
// default; per-user grantable/revocable in StaffForm). Enforced
// server-side here AND in every /api/invoices-inbox route —
// sidebar visibility follows the same key. Quality/data approval
// transitions additionally require master-or-owner-at-location
// (see api/invoices-inbox/_helpers.js).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import InvoicesInbox from '@/components/InvoicesInbox'

export const dynamic = 'force-dynamic'

export default async function InvoicesInboxPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/invoices')

  const isMaster = user.profileRole === 'master' || user.role === 'master'
  const permittedLocationIds = (user.locations || [])
    .map((l) => l.id)
    .filter((id) => hasPermissionForLocation(user, id, 'invoices_inbox'))
  if (!isMaster && permittedLocationIds.length === 0) redirect('/dashboard')

  // Locations + their forwarding-address slugs so the inbox header
  // can show the operator which email to use. Master sees all
  // locations; everyone else sees the locations where they hold
  // the invoices_inbox permission.
  const db = createServerClient()
  let locations = []
  if (isMaster) {
    const { data } = await db
      .from('locations')
      .select('id, name, invoices_inbound_slug')
      .eq('active', true)
      .eq('is_host_anchor', false)
      .order('name')
    locations = data || []
  } else {
    if (permittedLocationIds.length > 0) {
      const { data } = await db
        .from('locations')
        .select('id, name, invoices_inbound_slug')
        .in('id', permittedLocationIds)
        .order('name')
      locations = data || []
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Invoices</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Forward supplier invoices to the per-location email address below. Each invoice gets a two-step review — quality, then extracted data — before forwarding to Xero.
        </p>
      </header>
      <InvoicesInbox
        locations={locations}
        isMaster={isMaster}
        isBookkeeper={hasPermission(user, 'bookkeeper')}
      />
    </div>
  )
}
