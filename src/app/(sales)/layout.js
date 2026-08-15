// (sales) — Sales hub chrome. The group exists so /pipeline, /contacts and
// /activities share one tab strip WITHOUT changing their URLs (route groups
// are invisible to the router — phase-2 amended URL strategy). Pages keep
// their own gates and headers; this layout only adds the strip, and only
// when the user can see 2+ tabs.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline',   perm: 'pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts',   perm: 'contacts' },
  { id: 'tasks',    label: 'Tasks',    href: '/activities', perm: 'activities' },
]

export default async function SalesHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS.filter(t => hasPermission(user, t.perm)).map(({ perm: _p, ...t }) => t)
  return (
    <>
      {tabs.length > 1 && (
        <div className="px-8 pt-6">
          <HubTabs tabs={tabs} />
        </div>
      )}
      {children}
    </>
  )
}
