// INTEG-B3 — /settings/email-domain: self-serve per-tenant email sending
// domain (server-per-tenant). Owner/master only (the page carries its own
// server gate; the routes gate independently). Paid add-on — an org whose
// plan doesn't include custom_email_domain sees the upsell state.
//
// Master can view any org's state via ?organization_id (the GET route
// enforces the same access). Deep-link note: when B4 makes the integrations
// hub owner-visible, the hub's Email card lands here.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { isPostmarkAccountConfigured } from '@/lib/postmark-account'
import { orgHasEmailDomainAddon, tenantEmailStatePayload } from '@/lib/tenant-email'
import { resolveEmailDomainOrgId, loadEmailDomainRow } from '@/lib/email-domain-service'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, AtSign } from 'lucide-react'
import EmailDomainWizard from '@/components/settings/EmailDomainWizard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function EmailDomainSettingsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Owner/master only — the sending domain holds a live sending credential.
  if (user.role !== 'owner' && user.role !== 'master') redirect('/settings')

  const params = await searchParams
  const requestedOrg = user.role === 'master' ? (params?.organization_id || null) : null
  const resolved = resolveEmailDomainOrgId(user, requestedOrg)
  if (resolved.notFound || !resolved.orgId) redirect('/settings')
  const orgId = resolved.orgId

  const accountConfigured = isPostmarkAccountConfigured()
  const db = createServerClient()
  const [row, addonActive] = await Promise.all([
    loadEmailDomainRow(db, orgId),
    orgHasEmailDomainAddon(db, orgId),
  ])
  const state = tenantEmailStatePayload(row, { addonActive, accountConfigured })
  const orgName = user.organizationsById?.[orgId]?.name || null

  return (
    <div className="p-6 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={14} /> Settings
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <AtSign size={20} className="text-un1t-subtle" />
        <h1 className="text-2xl font-semibold">Email domain</h1>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        {orgName ? `${orgName} · ` : ''}send from your own verified domain on a dedicated mail server.
      </p>

      <EmailDomainWizard
        initialState={state}
        organizationId={user.role === 'master' ? orgId : null}
      />
    </div>
  )
}
