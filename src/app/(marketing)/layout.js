// (marketing) — Marketing hub chrome. Sixth application of the hub
// pattern (after (sales) HUBS.2a, (members) HUBS.2b, (money) HUBS.2c,
// (team) HUBS.2d, (operations) HUBS.2e): one tab strip shared across
// the hub's pages without changing any URL (route groups are
// invisible to the router). /automations keeps its own gate and
// header; this layout only adds the strip, and only when the user can
// see 2+ tabs.
//
// The Landing page tab is the one deliberate departure from every
// prior hub layout in this family: its href (`/welcome`) is the
// PUBLIC marketing site, not a route this group renders — `/welcome`
// lives outside auth entirely (SIDEBAR-IA.1's public-path allowlist),
// so nothing under (marketing) ever serves it. `newTab: true` (HUBS.2f
// Task 2 addition to HubTabs) renders it as a plain new-tab anchor
// instead of an in-app <Link>, matching the sidebar's own
// openInNewTab idiom for the same entry (src/lib/nav-items.js). No
// full-screen escape hatches are needed here (unlike (operations)'s
// timer/present routes) — every /automations sub-page ([id], templates,
// devices) already renders with ordinary page chrome (`p-6 max-w-*
// mx-auto` wrappers), so a tab strip above them is chrome-appropriate.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  // device_control is in this union for the same reason it's in the
  // sidebar entry's anyPermission (review fix, HUBS.2f) — the
  // Automations page's Tapo devices section (canDevices) gates on it
  // alone, so a device_control-only holder needs the tab to show too.
  { id: 'automations', label: 'Automations',  href: '/automations', perms: ['automations', 'email', 'whatsapp', 'device_control'] },
  { id: 'landing',     label: 'Landing page', href: '/welcome',     perms: ['landing_page'], newTab: true },
]

export default async function MarketingHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => !t.perms || t.perms.some(p => hasPermission(user, p)))
    .map(({ perms: _p, ...t }) => t)
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
