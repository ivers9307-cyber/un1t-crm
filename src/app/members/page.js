// /members — Members hub index. Mirrors /sales (HUBS.2a): the sidebar's
// single Members entry points here; the hub's surfaces keep their own
// URLs. Redirect to the first tab this user can see, in tab order.
// Gate keys mirror each PAGE's own gate (bookings page checks `bookings`,
// events checks `races`, etc.), not the old nav entries' looser gates.
//
// HUBDOOR.1 — the chain moved to src/lib/hub-index-chains.js as data so
// nav-items.test.js can prove every key in this hub's sidebar union
// reaches a real surface. Members has one key that deliberately does NOT
// (`events`, the pre-mig-092 ancestor of `races` that nothing gates on any
// more) — it's declared there as `visibilityOnly` with the reasoning,
// rather than silently missing from the chain the way `sms` and the fleet
// keys were in Marketing and Operations.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function MembersIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/members', hasPermission))
}
