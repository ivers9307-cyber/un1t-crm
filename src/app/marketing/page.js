// /marketing — Marketing hub index. Mirrors /operations (HUBS.2e).
// Automations first (the daily surface: curated toggles + custom
// flows + devices), then the landing-page editor.
//
// Deliberately routes to /settings/landing-page, NOT /welcome —
// /welcome is the PUBLIC marketing site itself (rendered for
// visitors, no auth), never an in-app pathname a signed-in operator
// should be redirected into. The in-app editor for it lives at
// /settings/landing-page (LandingPageSettingsForm). The sidebar's own
// Landing page entry reaches /welcome directly via openInNewTab —
// this index has nothing to do with that link.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function MarketingIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'automations') || hasPermission(user, 'email') || hasPermission(user, 'whatsapp')) redirect('/automations')
  if (hasPermission(user, 'landing_page')) redirect('/settings/landing-page')
  redirect('/')
}
