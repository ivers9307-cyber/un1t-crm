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
// (/settings/impersonate, /settings/service-credentials) this is gated by role at
// the page, not permission-gated — so there is no parity decision to
// make (check:mobile-parity only tracks WEB_PERMISSIONS keys).
//
// Data comes straight from the assembler (same code path the
// GET /api/integrations/hub route serves) — no HTTP self-call. The
// Master-view tier of the hub (UN1T-only customisation + org-gated
// cards) is hidden from non-masters via the isMaster prop.
//
// INTEGONE.3 — the hub is the ONLY integrations surface, so three pages fold
// in as views of this one (their old URLs redirect here):
//   ?view=health   the integration-health rows for one studio. The studio is
//                  ?location=<id> when it is one of the locations LOADED BELOW
//                  (that list IS the tenant scope: master every real location,
//                  owner/org-admin their organisation's), else the active
//                  location when it is in the list, else the first. Health is
//                  never run for an id outside the list.
//   ?view=zoom     the Zoom phone directory (ZoomContactsPanel keeps its own
//                  synced-organisation gate).
// plus the organisation WhatsApp numbers drawer: `managedOrgs` are the
// organisations among the loaded locations the viewer ADMINISTERS
// (isOrgAdmin), the only ones the WhatsApp card offers a numbers button for.
// The other views skip the (expensive) cards assembly: they render no cards.

import { redirect } from 'next/navigation'
import { getCurrentUser, getOwnerOrganizationIds, assertOrganizationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import { logError } from '@/lib/log'
import { getIntegrationHealth, worstStatus } from '@/lib/integration-health'
import IntegrationsHub from '@/components/settings/IntegrationsHub'
import IntegrationHealthPanel from '@/components/settings/IntegrationHealthPanel'
import ZoomContactsPanel from '@/components/settings/ZoomContactsPanel'
import { isActiveOrgAdmin, isOrgAdmin } from '@/lib/org-admin'

export const dynamic = 'force-dynamic'

const HUB_LOCATION_COLUMNS =
  'id, name, organization_id, active, settings, features, sensibo_api_key, sensibo_pod_id, ' +
  'thinq_pat, thinq_client_id, thinq_country_code, bca_config, timezone, membership_source'

/**
 * Which studio the Health view grades. Only ever an id from `locations` (the
 * org-scoped list the page loaded): the requested one, else the viewer's
 * active location, else the first. Pure.
 */
export function pickHealthLocation(locations, requestedId, activeId) {
  const list = locations || []
  const pick = (id) => (id ? list.find((l) => l.id === id) || null : null)
  return pick(requestedId) || pick(activeId) || list[0] || null
}

const first = (v) => (Array.isArray(v) ? v[0] : v)

export default async function IntegrationsHubPage({ searchParams } = {}) {
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

  const { data: locations, error } = await query
  // HUBREAD.1 — no locations read, no hub: an empty payload would render every
  // card "not connected" under Connect buttons and "All connections healthy".
  if (error) {
    logError('integrations-hub', 'hub page locations read failed', { error })
    return <HubUnavailable />
  }

  const sp = (await searchParams) || {}
  const requestedView = first(sp.view)
  const view = requestedView === 'health' || requestedView === 'zoom' ? requestedView : 'overview'

  // The Zoom tab shows only to people who can see more than the panel's own
  // "Not configured" shell: a master, or a member of the synced organisation
  // (the panel's own orgForbidden rule).
  const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
  const showZoom = user.isMaster || (!!syncOrgId && !assertOrganizationAccess(user, syncOrgId))

  if (view === 'health') {
    const picked = pickHealthLocation(locations, first(sp.location), user.activeLocation?.id)
    const rows = picked ? await getIntegrationHealth(db, picked.id) : []
    const panel = (
      <IntegrationHealthPanel
        rows={rows}
        overall={worstStatus(rows)}
        locationName={picked?.name || null}
        locations={(locations || []).map((l) => ({ id: l.id, name: l.name }))}
        selectedLocationId={picked?.id || null}
      />
    )
    return <IntegrationsHub view="health" viewPanel={panel} showZoom={showZoom} data={viewShellData(locations)} isMaster={user.isMaster} />
  }

  if (view === 'zoom') {
    return (
      <IntegrationsHub
        view="zoom"
        viewPanel={<ZoomContactsPanel user={user} db={db} />}
        showZoom={showZoom}
        data={viewShellData(locations)}
        isMaster={user.isMaster}
      />
    )
  }

  const managedOrgs = await loadManagedOrgs(db, user, locations || [])

  // C141 ORGROLE.2 — the plan & wallet strip is organisation-level billing
  // data: only the locations of an organisation the caller administers (a
  // master: every location). A studio owner keeps the integration cards.
  const data = await assembleIntegrationsHub(db, locations || [], {
    billingFor: (loc) => isOrgAdmin(user, loc.organization_id),
  })

  return (
    <IntegrationsHub
      data={data}
      isMaster={user.isMaster}
      canManageBilling={isActiveOrgAdmin(user)}
      managedOrgs={managedOrgs}
      showZoom={showZoom}
    />
  )
}

// The non-overview views render no cards, so the shell needs only the studio list.
function viewShellData(locations) {
  return { locations: (locations || []).map((l) => ({ id: l.id, name: l.name })) }
}

/**
 * The organisations the viewer administers among the loaded locations, with
 * the active studios the numbers drawer's home-studio picker offers (the old
 * /settings/whatsapp-numbers page's `active`, non-host-anchor filter; the hub
 * query already excludes host anchors). A failed organisation-name read gives
 * [] and a log: no button is better than a drawer over an unread org.
 */
async function loadManagedOrgs(db, user, locations) {
  const orgIds = [...new Set(locations.map((l) => l.organization_id).filter(Boolean))]
    .filter((orgId) => isOrgAdmin(user, orgId))
  if (orgIds.length === 0) return []
  const { data: orgs, error } = await db.from('organizations').select('id, name').in('id', orgIds)
  if (error) {
    logError('integrations-hub', 'hub page organisations read failed', { error })
    return []
  }
  const nameById = Object.fromEntries((orgs || []).map((o) => [o.id, o.name]))
  return orgIds.map((orgId) => ({
    id: orgId,
    name: nameById[orgId] || null,
    locations: locations
      .filter((l) => l.organization_id === orgId && l.active === true)
      .map((l) => ({ id: l.id, name: l.name })),
  }))
}

function HubUnavailable() {
  return (
    <div className="p-8 max-w-6xl">
      <div className="text-xs text-un1t-muted mb-1">Settings <span className="text-un1t-subtle font-medium">/ Integrations</span></div>
      <h2 className="text-2xl font-bold">Integrations</h2>
      <p className="text-sm text-amber-700 mt-2">
        Could not load your locations just now, so no connection is shown and none can be changed here. Reload the page to try again.
      </p>
    </div>
  )
}
