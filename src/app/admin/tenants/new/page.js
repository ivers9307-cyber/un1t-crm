// SAAS4-P2/P3 — /admin/tenants/new: the concierge tenant provisioning
// wizard (SaaS machinery plan §2; Richard 2026-07-19: concierge, "a
// wizard to talk you through step by step").
//
// Pure orchestration over routes that already exist — the wizard adds
// NO new API surface:
//   org       → POST /api/admin/organizations
//   location  → POST /api/locations         (seeds FUNNEL.1, SAAS4-W0.1)
//   owner     → POST /api/staff             (auth.admin invite)
//   branding  → PUT  /api/settings/org-branding
//   subdomain → POST /api/admin/tenant-domains (SAAS-8)
// Every completed step is a real resource; progress rides in the URL
// query (src/lib/tenant-wizard.js) so refresh/return resumes. Plan
// assignment + wallets stay with the Integrations track (/admin/plans)
// and appear on the finish checklist, not as a wizard step.
//
// Auth: the /admin layout was relaxed for Studio pages — this page
// enforces its own master gate like /admin/matrix.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import TenantWizard from '@/components/admin/TenantWizard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function NewTenantPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.profileRole !== 'master') redirect('/admin/matrix')

  const params = await searchParams
  return <TenantWizard initialParams={params || {}} />
}
