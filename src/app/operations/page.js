// /operations — Operations hub index. Mirrors /team (HUBS.2d). Maintenance
// first (the daily surface), then the door/devices panel, displays,
// presentations, and finally Fleet. Checklists shares studio_management
// with the Studio tab so it never needs its own chain step.
//
// HUBDOOR.1 — the chain itself now lives in src/lib/hub-index-chains.js as
// data, so nav-items.test.js can assert the invariant this page was
// breaking: every key in the Operations sidebar entry's `anyPermission`
// union must reach a real surface. It didn't. fleet_restart/fleet_admin
// joined the union in ADMIN.2h Task 2's review fix so a fleet-only persona
// would see an Operations door at all, but no branch here honoured them —
// they clicked it and bounced to '/', and could not see the Fleet tab
// either (it points outside the (operations) group, and HubTabs hides the
// strip below 2 visible tabs). The fleet step is the fix; see that module
// for what the chrome can and cannot do for that persona.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function OperationsIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/operations', hasPermission))
}
