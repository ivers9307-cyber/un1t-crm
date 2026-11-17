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
import { TEAM_TABS } from '@/lib/hub-tabs'
import { staffTabMetadata } from '@/lib/staff-tab-title'

export const dynamic = 'force-dynamic'

// PALETTE.1 — the tab list lives in src/lib/hub-tabs.js (unchanged), shared
// with the ⌘K palette so every tab is a jump target there too.
const TABS = TEAM_TABS

// TABTITLE.1 — the tab names the ACTIVE studio for every page under this
// layout (see src/lib/staff-tab-title.js). This is the OUTERMOST staff layout
// of its subtree: a layout nested under it must NOT export this again, or the
// tab reads "Studio · Studio".
export async function generateMetadata() {
  return staffTabMetadata()
}

export default async function TeamHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => !t.perms || t.perms.some(p => hasPermission(user, p)))
    .map(({ perms: _p, ...t }) => t)
  return (
    <>
      {tabs.length > 1 && (
        <div className="px-4 pt-6 sm:px-8 print:hidden">
          <HubTabs tabs={tabs} />
        </div>
      )}
      {children}
    </>
  )
}
