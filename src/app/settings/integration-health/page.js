// INTEGONE.3 — integration health is the Integrations hub's Health view
// (FEAT-INTEG-HEALTH.1 started life here). This URL stays so every bookmark and
// old link lands there. A signed-out caller still goes to /login first.
//
// Gate note: this page admitted any `settings` holder; the hub is owner+/master.
// The Settings tree already hid the row from everyone else "by product intent",
// so the page now matches the row.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hubViewHref } from '@/lib/integrations-hub-links'

export const dynamic = 'force-dynamic'

export default async function IntegrationHealthPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(hubViewHref('health'))
}
