// (money) — Money hub chrome. Third application of the hub pattern
// (after (sales) HUBS.2a and (members) HUBS.2b): the group shares one tab
// strip WITHOUT changing URLs (route groups are invisible to the router).
// Pages keep their own gates and headers; this layout only adds the strip,
// and only when the user can see 2+ tabs.
//
// Invoices carries `badgeUrl` — the first real use of HubTabs' badge
// support (built + tested in HUBS.2a but unused until now). It points at
// the SAME endpoint the sidebar's own Invoices entry polls
// (/api/invoices-inbox/unread-count), deliberately: CommunicationsTabs
// established that two counts which could disagree is worse than one, so
// the tab badge and the sidebar badge always agree because they're the
// same fetch, not two implementations of "unread".
//
// /orders: the tab carries the destination's role floor (HUBDOOR.4). It used
// to gate on the permission alone, mirroring the old sidebar entry, so a
// staff/reception holder of `orders` saw a tab that bounced them at the
// page's own MANAGER_ROLES guard — the dead-door shape HUBDOOR.1 exists to
// close, left open here because the Members strip was fixed and this one
// was not.
//
// DEEP.4 Task 1 (4A) — Contractor invoices + Staff expenses are
// CROSS-HUB tabs: their hrefs (/schedule/invoices, /schedule/expenses)
// point OUTSIDE this route group, into (team). Same technique as
// (operations)'s `fleet` tab (/admin/fleet) and (members)'s `live` tab
// (/live) — a hub tab is just a discoverable, permission-gated link;
// it doesn't require its target to live inside the hub's own group.
// Spec amendment (recon 2026-08-16, documented for review): moving
// those two pages under Money URLs would cost a NEW permission key
// (submitters hold no Money-union key — their only nav path today is
// Team → Schedule) purchased only for URL aesthetics, since the
// approvals rows/emails/`?focus` params work identically either way.
// So the URLs stay put and Money grows a reviewer-only door to them
// instead: gated on the APPROVER keys (approvals_contractor_invoices /
// approvals_fte_expenses), not the submitter-facing page gate (which
// is role/employment_type driven, not a permission check at all).
// Submitters keep reaching these pages via Team → Schedule; nothing
// about that path changes.
//
// Active-state note: arriving at either page renders NO Money strip
// (they're outside this group) — Team's own strip + sidebar entry
// light instead, because Team's extraActivePaths already claims the
// /schedule prefix and activeHrefFor is a longest-match ONE winner
// (src/lib/nav-items.js, src/lib/nav-items.test.js). This is the
// accepted cross-hub-tab UX, same as fleet/live above: the tab exists
// to give reviewers a discoverable path from Money, not to make the
// destination page part of Money's chrome.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'overview', label: 'Overview',      href: '/accounting',    perms: ['accounting_hub'] },
  { id: 'invoices', label: 'Invoices',      href: '/invoices',      perms: ['invoices_inbox'], badgeUrl: '/api/invoices-inbox/unread-count' },
  { id: 'receipts', label: 'Card receipts', href: '/card-receipts', perms: ['card_receipts'] },
  // HUBDOOR.4 — same floor HUBDOOR.2 gave Challenges in the Members strip:
  // /orders gates on MANAGER_ROLES AND the key, so a staff/reception holder of
  // `orders` alone was shown a tab that bounced them. A tab with no `roles`
  // has no floor.
  { id: 'orders',   label: 'Orders',        href: '/orders',        perms: ['orders'], roles: MANAGER_ROLES },
  { id: 'offers',   label: 'Offer sales',   href: '/offer-sales',   perms: ['approvals_offer_purchases'] },
  { id: 'contractor-invoices', label: 'Contractor invoices', href: '/schedule/invoices', perms: ['approvals_contractor_invoices'] },
  { id: 'expenses',            label: 'Staff expenses',      href: '/schedule/expenses', perms: ['approvals_fte_expenses'] },
]

export default async function MoneyHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => (!t.roles || t.roles.includes(user.role)) && t.perms.some(p => hasPermission(user, p)))
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
