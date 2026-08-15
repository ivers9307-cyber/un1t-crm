// /admin/plans — "Plans & pricing": master-only editor for the SaaS
// plan catalogue (INTEG-C1, mig 413).
//
// Every number (tier prices, metered allowances, overage rates,
// add-on prices) is DB-backed and edited here — code keeps only the
// feature keys / structure (shared/plans.js). Numbers are never
// edited in place: changing pricing creates a NEW plan version with
// an effective_from date; locations pin to a specific version, so
// existing pins keep their grandfathered numbers.
//
// Permissions: master-only page gate (profileRole), exactly like
// /settings/service-credentials — no WEB_PERMISSIONS key, so no mobile-parity
// entry is needed (the parity linter only walks WEB_PERMISSIONS).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import PlansAdmin from '@/components/PlansAdmin'

export const dynamic = 'force-dynamic'

export default async function AdminPlansPage() {
  // Page-level master gate (the /admin layout is relaxed — STUDIO-GROUP.1).
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()
  const { data } = await db
    .from('plans')
    .select('*, versions:plan_versions!plan_id(*)')
    .order('sort', { ascending: true })

  const plans = (data || []).map((p) => ({
    ...p,
    versions: (p.versions || []).sort((a, b) =>
      b.effective_from.localeCompare(a.effective_from)
    ),
  }))

  return (
    <div className="p-8 max-w-5xl">
      <h2 className="text-2xl font-bold mb-1">Plans &amp; pricing</h2>
      <p className="text-sm text-un1t-subtle mb-8 max-w-3xl">
        Per-location SaaS tiers and add-ons. All prices, allowances and
        overage rates live here, not in code. A plan&apos;s numbers are never
        edited in place — create a new version with an effective date, and
        locations pinned to an older version keep their existing pricing.
        EUR only. Nothing is enforced or billed yet — assignment ships with
        the wallets track.
      </p>
      <PlansAdmin initial={plans} />
    </div>
  )
}
