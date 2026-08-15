// (team) — Team hub chrome. Fourth application of the hub pattern
// (after (sales) HUBS.2a, (members) HUBS.2b, (money) HUBS.2c): the group
// shares one tab strip WITHOUT changing URLs (route groups are invisible
// to the router). Pages keep their own gates and headers; this layout
// only adds the strip, and only when the user can see 2+ tabs.
//
// NEW vs the (money) template: the Policies tab carries no `perms` —
// /policies' own gate is login-only (every signed-in employee can read
// it, per its page-level comment), so the tab must show for every
// signed-in user rather than being filtered by a permission key. The
// filter below treats a missing `perms` array as "always visible" so
// the no-perms case doesn't need a fake always-true permission key.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'schedule',  label: 'Schedule',  href: '/schedule',  perms: ['schedule'] },
  { id: 'contracts', label: 'Contracts', href: '/contracts', perms: ['contracts'] },
  // No perms — /policies is login-gated only, so the tab shows for every
  // signed-in user (mirrors the page's own gate, same rule as always).
  { id: 'policies',  label: 'Policies',  href: '/policies' },
]

export default async function TeamHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => !t.perms || t.perms.some(p => hasPermission(user, p)))
    .map(({ perms: _p, ...t }) => t)
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
