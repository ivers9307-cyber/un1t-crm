// Dashboard layout — shared by /dashboard/today, /dashboard/studio,
// /dashboard/business. Renders the parent AppShell (sidebar) and a
// segmented control matching the mobile Home tab. Permission gating
// is per-segment via shared/permissions.js cross-platform keys.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import AppShellServer from '@/components/AppShellServer'
import DashboardTabs from '@/components/dashboard/DashboardTabs'

const SEGMENTS = [
  { id: 'today',    label: 'Today',    href: '/dashboard/today',    perm: 'dashboard_personal' },
  { id: 'studio',   label: 'Studio',   href: '/dashboard/studio',   perm: 'dashboard_studio'   },
  { id: 'business', label: 'Business', href: '/dashboard/business', perm: 'dashboard_business' },
]

export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const perms = user.permissions || {}
  const isOwner = user.role === 'owner'
  const visible = SEGMENTS.filter(s => isOwner || perms[s.perm] === true)

  return (
    <AppShellServer>
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-un1t-white mb-1">Dashboard</h1>
        <p className="text-sm text-un1t-light mb-5">
          {user.activeLocation?.name || 'All locations'}
        </p>
        {visible.length > 1 ? (
          <DashboardTabs segments={visible} />
        ) : null}
        {children}
      </div>
    </AppShellServer>
  )
}
