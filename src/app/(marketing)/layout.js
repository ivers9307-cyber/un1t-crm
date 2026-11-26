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
// /communications/mail).
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
import MarketingHeader from '@/components/marketing/MarketingHeader'
import { MARKETING_TABS } from '@/lib/hub-tabs'
import { staffTabMetadata } from '@/lib/staff-tab-title'

export const dynamic = 'force-dynamic'

// PALETTE.1 — the tab list lives in src/lib/hub-tabs.js (unchanged), shared
// with the ⌘K palette so every tab is a jump target there too.
const TABS = MARKETING_TABS

// TABTITLE.1 — the tab names the ACTIVE studio for every page under this
// layout (see src/lib/staff-tab-title.js). This is the OUTERMOST staff layout
// of its subtree: a layout nested under it must NOT export this again, or the
// tab reads "Studio · Studio".
export async function generateMetadata() {
  return staffTabMetadata()
}

export default async function MarketingHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => (!t.perms || t.perms.some(p => hasPermission(user, p))) && (!t.roles || t.roles.includes(user.role)))
    .map(({ perms: _p, roles: _r, ...t }) => t)
  return (
    <>
      {tabs.length > 1 && (
        // MKTSHELL.1 — the shared title + strip row, at the same `p-6` inset
        // CommsShell gives the communications half of this hub.
        <div className="px-6 pt-6 print:hidden">
          <MarketingHeader tabs={tabs} />
        </div>
      )}
      {children}
    </>
  )
}
