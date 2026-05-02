// /account — self-service account preferences.
//
// Currently exposes:
//   - Default landing page (permissions.landing_preference)
//
// Linked to from the user block at the bottom of the sidebar.
// Visible to every authenticated user — no permission gate beyond
// "logged in". Sub-pages (e.g. /account/access-history) hang off
// this route segment.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight, History } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveLandingPreference } from '@shared/permissions'
import AccountForm from '@/components/AccountForm'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AccountPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Compute which landing options are reachable for this user at
  // their active location. Disabled options still render so users
  // can see what exists, but they can't pick something they have no
  // permission for.
  const allowed = {
    auto: true, // always available
    personal: hasPermission(user, 'dashboard_personal'),
    studio:   hasPermission(user, 'dashboard_studio'),
    business: hasPermission(user, 'dashboard_business'),
  }

  const currentPreference = resolveLandingPreference(user)

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-white">Account</h1>
        <p className="text-sm text-un1t-light mt-1">
          Personal preferences for {user.email}.
        </p>
      </div>

      <AccountForm
        initialPreference={currentPreference}
        allowed={allowed}
      />

      <div className="mt-8 pt-6 border-t border-un1t-gray">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-light mb-3">
          More
        </h2>
        <Link
          href="/account/access-history"
          className="flex items-center justify-between p-4 rounded-xl bg-un1t-dark border border-un1t-gray hover:border-un1t-light transition-colors"
        >
          <div className="flex items-center gap-3">
            <History size={18} className="text-un1t-light" />
            <div>
              <div className="text-sm font-medium text-un1t-white">Access history</div>
              <div className="text-xs text-un1t-light mt-0.5">
                See if anyone has impersonated your account
              </div>
            </div>
          </div>
          <ChevronRight size={16} className="text-un1t-light" />
        </Link>
      </div>
    </div>
  )
}
