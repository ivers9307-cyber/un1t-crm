// /marketing — Marketing hub index. Mirrors /operations (HUBS.2e).
// Automations first (the daily surface: curated toggles + custom
// flows + devices), then the landing-page editor, then Send.
//
// HUBDOOR.1 — the chain itself now lives in src/lib/hub-index-chains.js
// as data, so nav-items.test.js can assert the invariant this page kept
// breaking: every key in the Marketing sidebar entry's `anyPermission`
// union must reach a real surface. It didn't. `sms` was added to the
// union in DEEP.4 Task 2 (an sms-only holder needs a door to
// /communications/send and /sent, which admit `sms` alone) but no
// branch here honoured it, so exactly that persona clicked Marketing
// and bounced to '/'. The `sms` step is the fix; see that module for
// the full chain, its tab-order rationale, and why the landing-page
// step targets /settings/landing-page rather than the public /welcome.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveHubIndexTarget } from '@/lib/hub-index-chains'

export const dynamic = 'force-dynamic'

export default async function MarketingIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(resolveHubIndexTarget(user, '/marketing', hasPermission))
}
