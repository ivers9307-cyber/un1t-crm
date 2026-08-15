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
// /orders overshow: the tab mirrors the old sidebar entry's permission-only
// gate (orders permission alone). The page's own role guard
// (MANAGER_ROLES.includes(user.role)) still bounces non-managers who have
// the permission but not the role — same pre-existing overshow the /money
// index comment already documents, carried into the tab gate for
// consistency rather than fixed here.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'overview', label: 'Overview',      href: '/accounting',    perms: ['accounting_hub'] },
  { id: 'invoices', label: 'Invoices',      href: '/invoices',      perms: ['invoices_inbox'], badgeUrl: '/api/invoices-inbox/unread-count' },
  { id: 'receipts', label: 'Card receipts', href: '/card-receipts', perms: ['card_receipts'] },
  { id: 'orders',   label: 'Orders',        href: '/orders',        perms: ['orders'] },
  { id: 'offers',   label: 'Offer sales',   href: '/offer-sales',   perms: ['approvals_offer_purchases'] },
]

export default async function MoneyHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS
    .filter(t => t.perms.some(p => hasPermission(user, p)))
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
