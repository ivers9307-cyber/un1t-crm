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
//
// FU-COSMETICS — /achievements (the master-only achievements-catalogue
// editor) is ANOTHER chrome-free exception, moved out to
// src/app/achievements (2026-08-16). It used to sit inside this group with
// no tab of its own; a master editing the catalogue still saw this strip
// lit for whichever OTHER tabs they held perms for, with nothing to click
// back to this page. Same principle as the check-in/control surfaces above
// — an admin table the hub chrome does nothing for.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { CHALLENGE_ADMIN_ROLES } from '@/lib/challenges-access'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'bookings',   label: 'Bookings',    href: '/bookings',                perms: ['bookings'] },
  { id: 'events',     label: 'Events',      href: '/events',                  perms: ['races'] },
  // HUBDOOR.2 — `roles` is the destination's role floor. /challenges gates
  // on MANAGER_ROLES as well as the key (canAdminChallenges), so offering
  // the tab on the key alone showed a staff-role holder of `challenges` a
  // tab that bounced them. A tab with no `roles` has no floor.
  { id: 'challenges', label: 'Challenges',  href: '/challenges',              perms: ['challenges'], roles: CHALLENGE_ADMIN_ROLES },
  { id: 'pulse',      label: 'Pulse',       href: '/pulse',                   perms: ['pulse_admin'] },
  { id: 'live',       label: 'Live HR',     href: '/live',                    perms: ['studio_management'] },
  { id: 'timer',      label: 'Class timer', href: '/studio-management/timer', perms: ['class_timer'] },
  { id: 'hyrox',      label: 'Hyrox',       href: '/hyrox',                   perms: ['approvals_hyrox_sessions'] },
]

export default async function MembersHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children
  const tabs = TABS
    .filter(t => (!t.roles || t.roles.includes(user.role)) && t.perms.some(p => hasPermission(user, p)))
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
