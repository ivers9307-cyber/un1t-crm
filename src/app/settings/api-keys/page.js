// APIKEYS.2 — settings sub-page for per-org API key management.
// Organisation admins only (C18 ORGROLE.1); keys are scoped to the caller's
// active organization, which they must administer.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { activeOrganizationId, isOrgAdmin } from '@/lib/org-admin'
import { redirect } from 'next/navigation'
import ApiKeysSettings from '@/components/settings/ApiKeysSettings'

export const dynamic = 'force-dynamic'

export default async function ApiKeysPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // An admin of the active organisation — the management API's gate.
  const orgId = activeOrganizationId(user)
  if (!isOrgAdmin(user, orgId)) redirect('/settings')

  let keys = []
  if (orgId) {
    const db = createServerClient()
    const { data, error } = await db
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    // Never render "no keys" off a failed read: the error page instead.
    if (error) throw new Error(`api keys read failed: ${error.message}`)
    keys = data || []
  }

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">API keys</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Programmatic access for n8n and other integrations, scoped to{' '}
        <span className="text-un1t-text">{user.activeOrganization?.name || 'this organization'}</span>.
      </p>
      {orgId ? (
        <ApiKeysSettings initialKeys={keys} />
      ) : (
        <p className="text-sm text-un1t-subtle">
          No active organization for your session — switch to a location that belongs to an organization to manage its API keys.
        </p>
      )}
    </div>
  )
}
