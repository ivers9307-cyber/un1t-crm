// INTEGONE.1 — the per-location context behind the Integrations hub's Manage
// drawer (GET /api/integrations/hub/locations/[id]).
//
// The hub drawer hosts the FULL per-provider tabs that used to live only on
// /settings/locations/[id] (LocationIntegrations.jsx). Those tabs need exactly
// what that page assembled for them, so this module assembles the same thing
// with the same reads, copied verbatim from the page:
//
//   location                toClientLocation(select('*') row): AC keys become
//                           has_* flags, every other credential is masked,
//                           bca_config crosses intact. NEVER the raw row: it
//                           holds six credentials and this goes to a browser.
//   xeroConnection          the 15-column xero_connections row, or null
//   xeroReadFailed          CHANNELREAD.1: a failed read is never "not
//                           connected" (the tab would offer an OAuth rebind
//                           over a live connection)
//   sampleBcaCar            one car for the BCA template preview (only when
//                           features.bca_submit), or null
//   membershipSource        membershipSourceState(db, id)
//   hasUn1tOnlineConnection an ACTIVE un1t_online channel_connections row
//                           exists (head count; a failed count reads true,
//                           as on the page: the tab is owner/master anyway)
//   viewer                  the role expressions LocationIntegrations.jsx
//                           computed in the browser, computed here so the
//                           drawer never reasons about roles.
//
// The CALLER authorises (assertLocationAccess + guardMasterOrOwner AT this
// location, the page's two gates). Every read here keys off that location id.

import { toClientLocation } from '@/lib/location-client-shape'
import { membershipSourceState } from '@/lib/membership/source'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { isOrgAdmin } from '@/lib/org-admin'
import { ADMIN_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'

// The page's own select string for the Xero tab (XeroLocationCard reads
// these fields; scopes and expiry feed its status line).
export const HUB_XERO_CONNECTION_COLUMNS = `
        location_id, tenant_id, tenant_name, tenant_type,
        connected_at, last_refreshed_at, expires_at, scopes,
        bills_email_address,
        accounts_last_synced_at, contacts_last_synced_at,
        tax_rates_last_synced_at,
        accounts_sync_error, contacts_sync_error, tax_rates_sync_error,
        car_sales_account_code
      `

// The BCA template preview's sample car (the page's select string).
export const HUB_BCA_SAMPLE_CAR_COLUMNS =
  'uk_reg, irish_reg, vin, make, model, vehicle_year, buyer_name, buyer_email, xero_invoice_number'

/**
 * The five role answers the hosted tabs take as props. Pure.
 *   isMaster          user.role === 'master' (UniFi, BCA edit, AC device manage)
 *   isOwnerOrMaster   master, or owner AT this location (PAGEGATES.1)
 *   ownsWhatsAppHere  owner AT this location (WAROLE.1; hasRoleAtLocation's
 *                     master bypass reads profileRole)
 *   canSwitchWhatsApp ADMIN_ROLES at this location (the studio's number switch)
 *   canManageNumbers  an admin of the location's organisation
 */
export function hubViewerFlags(user, location) {
  const locationId = location?.id || null
  const isMaster = user?.role === 'master'
  return {
    isMaster,
    isOwnerOrMaster: isMaster || hasRoleAtLocation(user, locationId, ['owner']),
    ownsWhatsAppHere: hasRoleAtLocation(user, locationId, ['owner']),
    canSwitchWhatsApp: hasRoleAtLocation(user, locationId, ADMIN_ROLES),
    canManageNumbers: isOrgAdmin(user, location?.organization_id || null),
  }
}

/**
 * @param {object} db          createServerClient() (service role)
 * @param {object} user        getCurrentUser(), already authorised at locationId
 * @param {string} locationId
 * @returns {Promise<{ data: object|null, notFound: boolean, error: object|null }>}
 *   notFound: no such location row. error: the location row could not be
 *   read (REVIEWNITS.1: a failed read is not "no such location").
 */
export async function loadHubLocationContext(db, user, locationId) {
  const { data: locationRow, error: locationErr } = await db
    .from('locations')
    .select('*')
    .eq('id', locationId)
    .single()

  if (locationErr && locationErr.code !== 'PGRST116') {
    logError('integrations-hub-location', 'location read failed', { locationId, err: locationErr.message })
    return { data: null, notFound: false, error: locationErr }
  }
  if (!locationRow) return { data: null, notFound: true, error: null }

  // Everything below crosses to a client component: the shaped row only.
  const location = toClientLocation(locationRow)

  const [xeroRes, carRes, membershipSource, un1tConn] = await Promise.all([
    db.from('xero_connections')
      .select(HUB_XERO_CONNECTION_COLUMNS)
      .eq('location_id', location.id)
      .maybeSingle(),
    location.features?.bca_submit === true
      ? db.from('cars')
          .select(HUB_BCA_SAMPLE_CAR_COLUMNS)
          .eq('location_id', location.id)
          .in('status', ['pending', 'completed'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    membershipSourceState(db, location.id),
    // UN1TSYNC.7 — a head count: the row, and its token, never leave the server.
    db.from('channel_connections')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', location.id)
      .eq('platform', 'un1t_online')
      .eq('is_active', true),
  ])

  // CHANNELREAD.1 — the Xero tab renders "Could not load", never Connect.
  if (xeroRes?.error) {
    logError('integrations-hub-location', 'xero_connections read failed', { locationId: location.id, err: xeroRes.error.message })
  }
  // The preview is decorative: a failed read previews with no car, as before,
  // but it is logged rather than silently dropped.
  if (carRes?.error) {
    logError('integrations-hub-location', 'BCA sample car read failed', { locationId: location.id, err: carRes.error.message })
  }
  // A failed count keeps the un1t.online tab reachable (harmless: the tab is
  // owner/master and reads its own status); only a clean zero hides it.
  if (un1tConn?.error) {
    logError('integrations-hub-location', 'un1t_online connection count failed', { locationId: location.id, code: un1tConn.error.code ?? null })
  }

  return {
    data: {
      location,
      xeroConnection: xeroRes?.error ? null : (xeroRes?.data || null),
      xeroReadFailed: !!xeroRes?.error,
      sampleBcaCar: carRes?.error ? null : (carRes?.data || null),
      membershipSource,
      hasUn1tOnlineConnection: !!un1tConn?.error || (un1tConn?.count || 0) > 0,
      viewer: hubViewerFlags(user, location),
    },
    notFound: false,
    error: null,
  }
}
