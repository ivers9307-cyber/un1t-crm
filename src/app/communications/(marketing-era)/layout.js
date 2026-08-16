// (marketing-era) — the campaign-lifecycle chrome for /communications.
// DEEP.4 Task 2 (4B), spec amendment (recon 2026-08-16, documented for
// review): Send + Sent (+ [channel]/[id] editors) + Segments + list-health
// + the templates LIST are ONE campaign lifecycle with zero inbox coupling
// (proven — the inbox composers hit conversation endpoints, never
// /communications/send). They move OWNERSHIP to Marketing without moving
// a single URL: route groups are invisible to the router, so a THIRD group
// inside communications/ — sibling of (hub) and (editors) — can hold these
// five subtrees under the SAME literal `/communications/...` paths while
// giving them their own chrome instead of (hub)'s CommsShell + "Messages"
// header + CommunicationsTabs.
//
// Templates-list decision: the plan's mechanism section names only Send/
// Sent/Segments/list-health explicitly and separately says templates
// EDITORS stay in (editors) (already chrome-free — untouched by this PR).
// It is silent on the templates LIST page. Read literally, the list page
// is the same shape of campaign-content infrastructure as the other four
// — a manage-your-reusable-content surface, not an inbox/ticket one — so
// it moves here too, as a fifth tab. This does NOT touch the editors'
// back-links (TemplateEditor / WATemplateEditor point at
// `/communications/templates?channel=…`, a URL, not a route group) —
// comms-back-links.test.jsx stays green because it only ever asserted
// hrefs, never file locations.
//
// Segments carries BOTH `perms` and `roles`: this reproduces the
// pre-existing COMMSLAYOUT.3 gate exactly (channel permission AND
// manager role — the page itself only checks the role, but the OLD
// CommunicationsTabs deliberately required the channel permission too, so
// a manager who holds only `email_inbox` still doesn't see a Segments tab
// they'd immediately bounce out of on... no, they wouldn't bounce, but
// the tab would be visible with nothing channel-relevant behind it. Not
// loosened here.). `roles` is a small extension to the tab-filter
// convention every hub layout already has locally (`!t.perms ||
// t.perms.some(...)`) — mirrors settings-tree.js's `gate: { roles }`
// vocabulary, and (team)/layout.js already established that a hub layout
// filter can special-case a field being absent (`!t.perms ||`) rather
// than needing HubTabs itself to know about it.
//
// Chrome: reuses CommsShell (its `fullWidth` check only matches
// /communications/inbox and /communications/tickets, both still in
// (hub), so it's a no-op boxed `max-w-7xl` wrapper here) + a lighter h1
// than (hub)'s "Messages" — "Marketing sends" names what actually lives
// under this group (one-off + campaign sends, their history, the
// audiences that target them, and the content they're built from) without
// claiming the whole Marketing hub's territory (Automations/Landing stay
// out of this strip; see (marketing)/layout.js for their own tabs, which
// cross-link BACK here the same way (money)'s reviewer tabs cross-link
// into (team) — DEEP.4 Task 1's precedent, applied in the other
// direction).

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import HubTabs from '@/components/HubTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'send',        label: 'Send',        href: '/communications/send',        perms: ['email', 'whatsapp', 'sms'] },
  { id: 'sent',        label: 'Sent',        href: '/communications/sent',        perms: ['email', 'whatsapp', 'sms'] },
  { id: 'templates',   label: 'Templates',   href: '/communications/templates',   perms: ['email', 'whatsapp'] },
  { id: 'segments',    label: 'Segments',    href: '/communications/segments',    perms: ['email', 'whatsapp'], roles: MANAGER_ROLES },
  { id: 'list-health', label: 'List health', href: '/communications/list-health', perms: ['email'] },
]

export default async function MarketingEraLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // parent communications/layout.js + each page own their auth redirects

  const tabs = TABS
    .filter(t => (!t.perms || t.perms.some(p => hasPermission(user, p))) && (!t.roles || t.roles.includes(user.role)))
    .map(({ perms: _p, roles: _r, ...t }) => t)

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Marketing sends</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        Campaigns, one-off sends, audiences and list health for {user.activeLocation?.name || 'your studio'}
      </p>
      {tabs.length > 1 && <HubTabs tabs={tabs} />}
      {children}
    </CommsShell>
  )
}
