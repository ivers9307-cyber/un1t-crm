// /settings/integrations-hub — the Integrations hub (INTEG-B1).
//
// MASTER-ONLY in this phase — the rollout flag. profileRole !== 'master'
// redirects to /settings, so owners/staff see zero change and keep the
// per-location Integrations tabs (which this page only deep-links into).
// B4 swaps the hub in for everyone; the retired /settings/integrations
// path (INTEG-A4) stays retired until then.
//
// No WEB_PERMISSIONS key: master-only admin surfaces are role-gated at
// the page, not permission-gated (same posture as /settings/impersonate
// and /admin/integrations), so there is no parity decision to make —
// check:mobile-parity only tracks WEB_PERMISSIONS keys.
//
// Data comes straight from the assembler (same code path the
// GET /api/integrations/hub route serves) — no HTTP self-call.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import IntegrationsHub from '@/components/settings/IntegrationsHub'

export const dynamic = 'force-dynamic'

export default async function IntegrationsHubPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.profileRole !== 'master') redirect('/settings')

  const db = createServerClient()
  // Master sees every real location; host-anchor rows are synthetic
  // event-host containers with no integrations (same filter as the
  // /settings index).
  const { data: locations } = await db
    .from('locations')
    .select('id, name, active, settings, features, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, thinq_country_code, twilio_alpha_sender_id, bca_config')
    .eq('is_host_anchor', false)
    .order('created_at')

  const data = await assembleIntegrationsHub(db, locations || [])

  return <IntegrationsHub data={data} />
}
