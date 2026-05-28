// APIKEYS.2 — settings sub-page for per-org API key management.
// Owner/master only; keys are scoped to the caller's active organization.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import ApiKeysSettings from '@/components/settings/ApiKeysSettings'

export const dynamic = 'force-dynamic'

export default async function ApiKeysPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Owner/master only — same gate as the management API.
  if (!['master', 'owner'].includes(user.role)) redirect('/settings')

  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null

  let keys = []
  if (orgId) {
    const db = createServerClient()
    const { data } = await db
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    keys = data || []
  }

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ChevronLeft size={16} /> Settings
      </Link>
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
