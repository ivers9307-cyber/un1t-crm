// (operations) — Operations hub chrome. Fifth application of the hub
// pattern (after (sales) HUBS.2a, (members) HUBS.2b, (money) HUBS.2c,
// (team) HUBS.2d): one tab strip shared across five pages without
// changing any URL (route groups are invisible to the router). Pages
// keep their own gates and headers; this layout only adds the strip,
// and only when the user can see 2+ tabs.
//
// Two full-screen surfaces escape the group back to literal trees so
// they render with NO Operations chrome, same technique as
// src/app/events/[id]/checkin (HUBS 2B precedent):
//   - /studio-management/timer — a class-interval countdown shown on
//     the studio TV. It's a Members-hub-adjacent coach tool, not an
//     Operations tab, and a tab strip on a TV-facing timer would be
//     visual noise (and wrong scope) for whoever is watching it.
//   - /presentations/[id]/present — the presenter's remote for a
//     full-screen slide deck rendered across other screens; it needs
//     the entire viewport for deck controls, not a hub tab strip.
//
// ADMIN.2h Task 2 — the `fleet` tab's href (/admin/fleet) is OUTSIDE this
// route group, same technique as (members)'s `live` tab (Live HR, at
// /live rather than a (members) path — see that layout's header
// comment). A route group's layout only wraps routes literally inside
// it, so arriving at /admin/fleet renders NO Operations strip — the tab
// exists purely to give fleet a discoverable, persistent nav entry (it
// had none: /admin's index page was its only bridge, and that index
// dies in ADMIN.2h Task 3). The page itself is untouched — still at
// /admin/fleet, still rendering inside the normal studio AppShell
// (it is deliberately NOT a platform-tier path — see platform-nav.js's
// header comment on why fleet stays out of that contract). Masters
// reach it too: resolvePermission's master bypass (shared/permissions.js)
// returns true for any key once the location feature-gate passes, so
// `fleet_restart`/`fleet_admin` both resolve true for a master and the
// tab shows for them exactly as it does for permission holders.
//
// The checklists tab shares the `studio_management` perms key with
// the Studio tab rather than getting its own. Its page (`page.js`)
// also admits owner/master directly ahead of the permission check —
// master always lands (hasPermission's own resolver bypass returns
// true for master regardless of the perms map), and an owner's row in
// DEFAULT_WEB_PERMISSIONS_BY_ROLE (shared/permissions.js) sets
// `studio_management: true` by default, so routing the checklists tab
// through `studio_management` alone still shows it to a default-config
// owner — the direct role check in canEnter() is belt-and-braces for
// an owner whose permission was hand-toggled off, not the thing making
// owners see the tab in the common case.
//
// `!t.perms ||` (the (team) HUBS.2d capability for a login-only tab
// with no perms key) is available below but unused here — every
// Operations tab carries a real perms array.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'maintenance',   label: 'Maintenance',   href: '/maintenance',       perms: ['equipment_admin', 'equipment_inspect'] },
  { id: 'studio',        label: 'Studio',        href: '/studio-management', perms: ['studio_management'] },
  { id: 'tv',            label: 'TV displays',   href: '/tv-displays',       perms: ['tv_displays'] },
  { id: 'presentations', label: 'Presentations', href: '/presentations',     perms: ['presentations'] },
  { id: 'checklists',    label: 'Checklists',    href: '/checklists',        perms: ['studio_management'] },
  // ADMIN.2h Task 2 — href is OUTSIDE the (operations) group (see header
  // comment): arriving here renders no strip, same as (members)'s `live`.
  { id: 'fleet',         label: 'Fleet',         href: '/admin/fleet',       perms: ['fleet_restart', 'fleet_admin'] },
]

export default async function OperationsHubLayout({ children }) {
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
