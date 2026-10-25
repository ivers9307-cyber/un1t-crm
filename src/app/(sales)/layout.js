// (sales) — Sales hub chrome. The group exists so /pipeline, /contacts and
// /activities share one tab strip WITHOUT changing their URLs (route groups
// are invisible to the router — phase-2 amended URL strategy). Pages keep
// their own gates and headers; this layout only adds the strip, and only
// when the user can see 2+ tabs.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'
import { staffTabMetadata } from '@/lib/staff-tab-title'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline',   perm: 'pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts',   perm: 'contacts' },
  { id: 'tasks',    label: 'Tasks',    href: '/activities', perm: 'activities' },
]

// TABTITLE.1 — the tab names the ACTIVE studio for every page under this
// layout (see src/lib/staff-tab-title.js). This is the OUTERMOST staff layout
// of its subtree: a layout nested under it must NOT export this again, or the
// tab reads "Studio · Studio".
export async function generateMetadata() {
  return staffTabMetadata()
}

export default async function SalesHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS.filter(t => hasPermission(user, t.perm)).map(({ perm: _p, ...t }) => t)
  return (
    <>
      {tabs.length > 1 && (
        <div className="px-8 pt-6 print:hidden">
          <HubTabs tabs={tabs} />
        </div>
      )}
      {children}
    </>
  )
}
