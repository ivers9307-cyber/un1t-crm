// EVENTS-HOST.2 — /settings/hosts index (operator UI for event HOSTS).
//
// An "event host" is a third-party who gets paid directly for their
// events via their own Stripe account (Stripe Connect). Operators
// create a host here, then open it and click "Connect with Stripe"
// to run Stripe's hosted onboarding. See src/lib/event-hosts.js for
// the payment-routing + fee math this UI configures.
//
// Server component: this file owns only the Manager+ auth gate (the
// established pattern for /settings sub-pages — class-categories,
// holidays, shifts). The list + create form live in the HostsManager
// client component, which fetches the /api/hosts routes directly.

import { getCurrentUser } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { redirect } from 'next/navigation'
import { Store } from 'lucide-react'
import HostsManager from '@/components/settings/HostsManager'
import HostEventReviewQueue from '@/components/settings/HostEventReviewQueue'

export const dynamic = 'force-dynamic'

export default async function HostsSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Owner/manager only (ADMIN_ROLES — excludes head_coach). Managing payout
  // accounts + fees is a money-handling capability, so it matches the
  // /api/hosts backend gate rather than the broader MANAGER_ROLES.
  if (!ADMIN_ROLES.includes(user.role)) redirect('/')

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold inline-flex items-center gap-2">
          <Store size={20} className="text-un1t-subtle" /> Event hosts
        </h2>
        <p className="text-sm text-un1t-subtle mt-1">
          Third-party organisers who get paid directly for their events. Connect a host to Stripe so
          their tickets settle to their own account, with UN1T&rsquo;s booking fee kept per ticket.
        </p>
      </div>

      {/* HOST-PORTAL.3 — host self-serve events land here for staff approval
          before they publish. Self-fetches; renders above the hosts list. */}
      <div className="mb-6">
        <HostEventReviewQueue />
      </div>

      <HostsManager />
    </div>
  )
}
