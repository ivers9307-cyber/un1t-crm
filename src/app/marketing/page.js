// /marketing — Marketing hub index. Mirrors /operations (HUBS.2e).
// Automations first (the daily surface: curated toggles + custom
// flows + devices), then the landing-page editor.
//
// The first branch's OR must match /automations' own gate exactly —
// canCurated || canFlows || canDevices in src/app/(marketing)/
// automations/page.js, where canDevices is device_control alone (the
// Tapo devices section, /automations/devices). Review fix (HUBS.2f):
// device_control was missing here, so a device_control-only holder
// (no automations/email/whatsapp) fell through to the '/' fallback
// instead of landing on the one tab they can actually see.
//
// Deliberately routes to /settings/landing-page, NOT /welcome —
// /welcome is the PUBLIC marketing site itself (rendered for
// visitors, no auth), never an in-app pathname a signed-in operator
// should be redirected into. The in-app editor for it lives at
// /settings/landing-page (LandingPageSettingsForm). The sidebar's own
// Landing page entry reaches /welcome directly via openInNewTab —
// this index has nothing to do with that link.
//
// Known quirk (traced in review, accepted as-is): a landing_page-only
// user redirects here to /settings/landing-page, where the sidebar
// highlights the Settings entry, not Marketing — /settings/landing-page
// is Settings-owned content (SIDEBAR-IA.1), and no single pathname-based
// highlight rule can serve both arrival journeys (via Marketing's index
// redirect, and via Settings directly) at once.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function MarketingIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'automations') || hasPermission(user, 'email') || hasPermission(user, 'whatsapp') || hasPermission(user, 'device_control')) redirect('/automations')
  if (hasPermission(user, 'landing_page')) redirect('/settings/landing-page')
  redirect('/')
}
