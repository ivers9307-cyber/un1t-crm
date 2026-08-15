// /admin/* — master console + a couple of narrower-audience platform
// tools. Distinct from /settings/* (per-location operator admin).
//
// ADMIN.2h dissolved the old /admin index hub (Task 3) and, across both
// tasks, relocated every child that had its own operator-facing
// permission out from under this tree entirely: contracts → /contracts
// (HUBS.2d), tv-displays/checklists → the Operations hub (HUBS.2e),
// glofox-import/marketing-import/audit-log/achievements/service-
// credentials/policies → /settings or /achievements (ADMIN.2h Task 1).
// The old STUDIO-GROUP.1 relax (ADMIN_CHILD_PERMS — "let a Studio
// Management permission holder past this gate") is GONE because there
// is no longer a Studio Management child living under /admin/* for it
// to admit someone to.
//
// What's actually left here (verified against src/app/admin/*):
//   tenants, plans, tenant-domains, health, matrix, bridges,
//   studio-devices — all master-only at the page level.
//   webhook-dead-letter — master-OR-owner at the page level.
//   fleet — master (isMaster bypass) or per-location fleet_restart/
//     fleet_admin holder; the page itself does the per-device filtering
//     once past this gate.
//
// SEC fix (ADMIN.2h review): `health` was the ONE resident that did NOT
// actually carry its own page-level gate when this layout comment was
// first written — its page.js merely claimed to "inherit the
// master-only gate from /admin/layout.js" (a layout that, by this
// point, was never hard master-only). That made the "every OTHER
// resident redirects a non-master owner/fleet-holder right back out"
// claim below FALSE for health specifically: once this layout admitted
// owner and fleet_restart/fleet_admin, they could load cross-tenant
// platform health (org-wide integration errors, AI spend, heartbeats)
// with no further check. health now enforces its own page-level
// master-only gate directly (see its header comment), closing that
// historical exception — the claim below is accurate for every
// resident as of this fix, not just the other eight.
//
// New rule, sized to that actual resident set:
//   - master: always allowed (covers every resident).
//   - owner: allowed (needed for webhook-dead-letter; every OTHER
//     resident — health included, as of the fix above — still
//     redirects a non-master owner right back out via its own
//     page-level master-only gate, so this doesn't widen access to
//     them — see each page's header comment).
//   - hasPermission('fleet_restart' | 'fleet_admin'): allowed (needed
//     for a non-owner coach/manager/head_coach with fleet rights;
//     fleet's page then does the per-device visibility check RLS can't
//     express, since fleet_devices has no location_id filter that maps
//     1:1 to "assigned to me". Every other resident's page-level
//     master-only or master-or-owner gate turns a fleet-only holder
//     away just as it does a plain owner.)
//   - everyone else: redirect('/').
//
// RLS at the data layer is the second line of defence — even if
// someone somehow reached an /admin/* page they don't have permission
// for, they'd see no data because RLS enforces tenancy + role at the
// row level.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // user.role flips per active location; profileRole is the canonical
  // global value. Master is platform-wide so we read from profileRole
  // (which is 'master') rather than the per-location role.
  if (user.profileRole === 'master') return children
  // Owner — needed for webhook-dead-letter (master-or-owner at the page
  // level); every other resident's own master-only gate still turns a
  // non-master owner away.
  if (user.role === 'owner') return children
  // fleet_restart / fleet_admin holder — needed for a non-owner coach,
  // manager or head_coach who can operate the studio Pis. fleet's page
  // does its own per-device location check once past this gate.
  if (hasPermission(user, 'fleet_restart') || hasPermission(user, 'fleet_admin')) return children
  redirect('/')
}
