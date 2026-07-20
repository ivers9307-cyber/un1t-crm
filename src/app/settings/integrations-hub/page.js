// /settings/integrations-hub — the Integrations hub (INTEG-B1 / B4).
//
// ACCESS (B4 rollout — now the PRIMARY integrations surface): owner+ /
// org-admin / master. Non-owner/master (managers, head coaches, staff)
// redirect to /settings — unchanged redirect shape from phase B, just a
// wider allowed set. The role set mirrors GET /api/integrations/hub
// exactly.
//   - master        → every real location.
//   - owner/org-admin → ONLY their own organisation(s)' locations
//     (getOwnerOrganizationIds → .in('organization_id', …)); the payload
//     is hard-scoped so no cross-tenant data can render.
//
// No WEB_PERMISSIONS key: like the other role-gated admin surfaces
// (/settings/impersonate, /admin/integrations) this is gated by role at
// the page, not permission-gated — so there is no parity decision to
// make (check:mobile-parity only tracks WEB_PERMISSIONS keys).
//
// Data comes straight from the assembler (same code path the
// GET /api/integrations/hub route serves) — no HTTP self-call. The
// Master-view tier of the hub (UN1T-only customisation + org-gated
// cards) is hidden from non-masters via the isMaster prop.

import { redirect } from 'next/navigation'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import IntegrationsHub from '@/components/settings/IntegrationsHub'

export const dynamic = 'force-dynamic'

const HUB_LOCATION_COLUMNS =
  'id, name, active, settings, features, sensibo_api_key, sensibo_pod_id, ' +
  'thinq_pat, thinq_client_id, thinq_country_code, twilio_alpha_sender_id, bca_config'

export default async function IntegrationsHubPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Owner+/master. Non-masters need at least one owned/administered org.
  const ownerOrgIds = user.isMaster ? null : getOwnerOrganizationIds(user)
  if (!user.isMaster && ownerOrgIds.length === 0) redirect('/settings')

  const db = createServerClient()
  // Master sees every real location; owner/org-admin only their org(s)'.
  // Host-anchor rows are synthetic event-host containers with no
  // integrations (same filter as the /settings index).
  let query = db
    .from('locations')
    .select(HUB_LOCATION_COLUMNS)
    .eq('is_host_anchor', false)
    .order('created_at')
  if (!user.isMaster) query = query.in('organization_id', ownerOrgIds)

  const { data: locations } = await query

  const data = await assembleIntegrationsHub(db, locations || [])

  return <IntegrationsHub data={data} isMaster={user.isMaster} />
}
