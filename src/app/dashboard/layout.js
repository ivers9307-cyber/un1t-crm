// Dashboard layout — shared chrome for /dashboard/today,
// /dashboard/studio, /dashboard/business. Provides the page header
// + the top-of-page segmented control. Does NOT render AppShell —
// that's already done by the root app/layout.js, and double-wrapping
// produces a duplicate sidebar.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import DashboardTabs from '@/components/dashboard/DashboardTabs'

const SEGMENTS = [
  { id: 'today',    label: 'Today',    href: '/dashboard/today',    perm: 'dashboard_personal' },
  { id: 'studio',   label: 'Studio',   href: '/dashboard/studio',   perm: 'dashboard_studio'   },
  { id: 'business', label: 'Business', href: '/dashboard/business', perm: 'dashboard_business' },
  // SIDEBAR-IA.1 — the radars relocated from standalone sidebar
  // entries to dashboard tabs ("how's the business" lives in one
  // place). Short labels keep five segments readable; the pages keep
  // their own permission gates, this strip is display-only.
  { id: 'churn',    label: 'Churn',    href: '/dashboard/churn-radar', perm: 'churn_radar' },
  { id: 'leads',    label: 'Leads',    href: '/dashboard/lead-radar',  perm: 'lead_radar'  },
  // P2-7 — engagement→churn analytics (friend-count vs retention + app adoption).
  { id: 'engagement', label: 'Engagement', href: '/dashboard/engagement', perm: 'engagement_analytics' },
  // ADS-REPORT — paid-ad performance joins the dashboard tab family (moved out of the sidebar).
  { id: 'ads',        label: 'Ads',        href: '/dashboard/ads',        perm: 'dashboard_ads' },
]

export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const visible = SEGMENTS.filter(s => hasPermission(user, s.perm))

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Dashboard</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {user.activeLocation?.name || 'All locations'}
      </p>
      {visible.length > 1 ? (
        <DashboardTabs segments={visible} />
      ) : null}
      {children}
    </div>
  )
}
