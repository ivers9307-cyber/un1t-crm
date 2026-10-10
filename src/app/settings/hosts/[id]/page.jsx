// EVENTS-HOST.2 — /settings/hosts/[id] (event host detail).
//
// Server component: Manager+ auth gate only (matches the index page and
// the sibling settings sub-pages). The editable form, "Connect with
// Stripe" flow, and the ?stripe=return → sync-on-load behaviour all live
// in the HostDetail client component, which fetches the /api/hosts/[id]
// routes directly.

import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { isActiveOrgAdmin } from '@/lib/org-admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import HostDetail from '@/components/settings/HostDetail'
import { createServerClient } from '@/lib/supabase'
import { getLocationBranding } from '@/lib/location-branding'

export const dynamic = 'force-dynamic'

export default async function HostDetailPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // ADMIN_ROLES (owner/manager) — matches the money-handling backend gate.
  if (!ADMIN_ROLES.includes(user.role)) redirect('/')

  // W1.S2 — the org's brand labels its own staff logins on the detail card.
  const { companyName: brand } = await getLocationBranding(createServerClient(), user.activeLocation?.id)

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href="/settings/hosts"
        className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text mb-3"
      >
        <ChevronLeft size={14} /> Event hosts
      </Link>
      {/* C18 ORGROLE.1 — the Postmark back-fill shows only to an organisation
          admin (its route's rule). */}
      <HostDetail hostId={params.id} canBackfill={isActiveOrgAdmin(user)} brand={brand} />
    </div>
  )
}
