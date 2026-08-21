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
//
// DEEP.4 Task 2 (4B) — five CROSS-HUB tabs join Automations/Landing:
// Send, Sent, Templates, Segments, List health, all hrefs OUTSIDE this
// route group (communications/(marketing-era) — see that layout's
// header comment for the ownership move). Same technique as (money)'s
// two reviewer tabs into (team) (DEEP.4 Task 1) and (operations)'s
// `fleet` tab into /admin/fleet: a hub tab's target doesn't have to
// live inside the hub's own group, it just has to be a discoverable,
// permission-gated link. The difference from Task 1's Money case:
// there, Team's OWN extraActivePaths already claimed /schedule/*, so
// arriving at the target kept Team's sidebar highlight. Here, Marketing
// deliberately CLAIMS the /communications/send|sent|templates|segments|
// list-health paths in its own extraActivePaths (src/lib/nav-items.js)
// — this is a genuine ownership move, not just a discovery link, so the
// sidebar should highlight Marketing on those pages, not Messages
// (which still owns bare /communications, /communications/inbox and
// /communications/tickets).
//
// Segments carries `roles: MANAGER_ROLES` alongside its `perms` — the
// `roles` field is a small extension to this file's own tab-filter
// (mirrors settings-tree.js's `gate: { roles }` vocabulary; the (team)
// HUBS.2d no-perms capability, `!t.perms ||`, is the direct precedent
// for a filter special-casing an absent field). It reproduces the
// pre-existing COMMSLAYOUT.3 gate exactly: channel permission AND
// manager role, matching (marketing-era)/layout.js's own Segments tab
// definition so the SAME population sees Segments regardless of which
// hub they discover it from.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  // device_control is in this union for the same reason it's in the
  // sidebar entry's anyPermission (review fix, HUBS.2f) — the
  // Automations page's Studio music (Sonos) section (canDevices) gates
  // on it alone, so a device_control-only holder needs the tab to show too.
  { id: 'automations', label: 'Automations',  href: '/automations', perms: ['automations', 'email', 'whatsapp', 'device_control'] },
  { id: 'landing',     label: 'Landing page', href: '/welcome',     perms: ['landing_page'], newTab: true },
  { id: 'send',        label: 'Send',         href: '/communications/send',        perms: ['email', 'whatsapp', 'sms'] },
  { id: 'sent',        label: 'Sent',         href: '/communications/sent',        perms: ['email', 'whatsapp', 'sms'] },
  { id: 'templates',   label: 'Templates',    href: '/communications/templates',   perms: ['email', 'whatsapp'] },
  { id: 'segments',    label: 'Segments',     href: '/communications/segments',    perms: ['email', 'whatsapp'], roles: MANAGER_ROLES },
  { id: 'list-health', label: 'List health',  href: '/communications/list-health', perms: ['email'] },
]

export default async function MarketingHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => (!t.perms || t.perms.some(p => hasPermission(user, p))) && (!t.roles || t.roles.includes(user.role)))
    .map(({ perms: _p, roles: _r, ...t }) => t)
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
