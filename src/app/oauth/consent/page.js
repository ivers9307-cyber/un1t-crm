// MCP.1 — /oauth/consent: where Supabase's OAuth server sends a person to
// approve or deny an MCP client (Claude, Claude Code) connecting to the staff
// MCP server. Dashboard: Authentication → OAuth Server → Authorization Path.
//
// Public in the four-allowlist sense (src/public-compliance-paths.test.jsx):
// the person may arrive with no session, so THIS page signs them in via
// /login?redirect=<this url> and brings them back. It never approves on
// anyone's behalf; the client form does that from the browser, and the form
// disables Approve when the eligibility below says the person may not.
//
// Eligibility here is a courtesy to the person (a clear reason instead of a
// connection that then refuses every tool). The authority is the registry on
// the MCP route, which re-checks the org switch and the permission per call.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionAtAnyLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { mcpEnabledOrgIds } from '@/lib/mcp/auth'
import OAuthConsentForm from '@/components/OAuthConsentForm'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Connect an app',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function OAuthConsentPage({ searchParams }) {
  const params = (await searchParams) || {}
  const raw = params.authorization_id
  const authorizationId = Array.isArray(raw) ? raw[0] : raw

  if (!authorizationId) {
    return (
      <main className="min-h-screen bg-un1t-bg flex items-center justify-center px-4 py-16">
        <p className="text-sm text-un1t-muted">This link is incomplete. Start the connection again from the app.</p>
      </main>
    )
  }

  const user = await getCurrentUser()
  if (!user) {
    redirect(
      '/login?redirect=' +
        encodeURIComponent('/oauth/consent?authorization_id=' + encodeURIComponent(authorizationId)),
    )
  }

  // Under a master's "View as user" the eligibility below would be the
  // impersonated person's, but Approve runs on the master's real browser
  // session, so the grant would land on the master. Refuse; no Approve path.
  if (user.impersonatingFrom) {
    return (
      <main className="min-h-screen bg-un1t-bg flex items-center justify-center px-4 py-16">
        <p role="alert" className="text-sm text-un1t-text">
          Stop viewing as another user before connecting an app.
        </p>
      </main>
    )
  }

  const enabledOrgs = await mcpEnabledOrgIds(createServerClient(), user)
  const assistant = hasPermissionAtAnyLocation(user, 'assistant')
  const eligibility = enabledOrgs.length === 0
    ? { ok: false, reason: 'mcp_disabled' }
    : !assistant
      ? { ok: false, reason: 'assistant_permission' }
      : { ok: true, reason: null }

  return (
    <main className="min-h-screen bg-un1t-bg flex items-center justify-center px-4 py-16">
      <OAuthConsentForm
        authorizationId={authorizationId}
        eligibility={eligibility}
        personName={user.full_name || user.email || ''}
      />
    </main>
  )
}
