// (members) — Members hub chrome. Same pattern as (sales)/layout.js: the
// group shares one tab strip WITHOUT changing member URLs. Live HR and the
// class timer are tabs but their routes stay OUTSIDE the group — they are
// full-screen surfaces and must not inherit the strip. The event check-in
// subtree (/events/[id]/checkin + /checkin/scan) and the race-day control
// console (/events/[id]/control) live outside the group for the same
// reason — a phone scan surface and a tablet race console, chrome-free by
// design. Tab visibility mirrors each PAGE's own gate (not the old nav
// entries' looser gates); /live has no page gate today (tracked
// separately) — its tab uses the nav-documented studio_management key.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'bookings',   label: 'Bookings',    href: '/bookings',                perms: ['bookings'] },
  { id: 'events',     label: 'Events',      href: '/events',                  perms: ['races'] },
  { id: 'challenges', label: 'Challenges',  href: '/challenges',              perms: ['challenges'] },
  { id: 'pulse',      label: 'Pulse',       href: '/pulse',                   perms: ['pulse_admin'] },
  { id: 'live',       label: 'Live HR',     href: '/live',                    perms: ['studio_management'] },
  { id: 'timer',      label: 'Class timer', href: '/studio-management/timer', perms: ['class_timer'] },
  { id: 'hyrox',      label: 'Hyrox',       href: '/hyrox',                   perms: ['approvals_hyrox_sessions'] },
]

export default async function MembersHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children
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
