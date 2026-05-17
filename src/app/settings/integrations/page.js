// Settings → Integrations standalone page — superseded by the
// per-location Integrations tab (Settings → Locations → <name> →
// Integrations tab strip) introduced in SETTINGS.1 + .2 + .3.
//
// Kept as a redirect rather than deleted so any operator bookmarks
// land in a sensible place. Direct deep-link still works via
// /settings/locations/<id>?tab=xero.
//
// NOTE: the Xero OAuth callback in /api/xero/callback redirects
// back to this URL on success. Once that callback is updated to
// land back on the per-location settings page, this file can be
// deleted entirely.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function IntegrationsPageRedirect() {
  redirect('/settings')
}
