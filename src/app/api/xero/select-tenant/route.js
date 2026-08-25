// XERO-ONE-ORG.1 — GET the Xero organisations this location's token grants,
// and POST to switch the location onto a different one.
//
// Why this exists: the OAuth callback has to store SOME org before the
// operator can see what it picked, and Xero's consent screen accumulates
// grants, so the list a login returns is every org it has ever authorised.
// Without this route, correcting a wrong binding meant re-running OAuth and
// hoping the right org came back first — which is how three locations ended
// up on one org in the first place. The stored refresh token already grants
// every org in the list, so switching needs no new consent.
//
// Switching REPLACES the org this location files bills into, so it also
// purges the per-location caches. Accounts, tax rates and contacts are all
// org-specific (Xero ids are per-org), and leaving them would let an operator
// pick an account code that does not exist in the new org — the failure would
// surface as an opaque Xero validation error at send time.
//
// Bills already pushed are NOT touched. Moving a posted bill between Xero
// organisations is an accounting decision (void and re-enter, or a journal),
// not something a settings toggle may do silently.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { withFreshToken, listConnectedTenants } from '@/lib/xero/client'
import { classifyTenants, validateTenantChoice } from '@/lib/xero/tenant-binding'
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SelectSchema = z.object({
  location_id: uuidLike,
  tenant_id: z.string().min(1).max(100),
})

// Owner/master only — same bar as connecting or disconnecting, since this
// decides which company's books the location's bills land in.
function permitted(user) {
  return user?.role === 'owner' || user?.role === 'master'
}

async function loadExisting(db) {
  const { data } = await db
    .from('xero_connections')
    .select('tenant_id, location_id, locations:location_id ( name )')
  return (data || []).map((r) => ({
    tenant_id: r.tenant_id,
    location_id: r.location_id,
    location_name: r.locations?.name || null,
  }))
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!permitted(user)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: conn } = await db
    .from('xero_connections')
    .select('tenant_id')
    .eq('location_id', locationId)
    .maybeSingle()
  if (!conn) return NextResponse.json({ success: false, error: 'This location has no Xero connection.' }, { status: 404 })

  let tenants
  try {
    const { conn: fresh } = await withFreshToken(locationId)
    tenants = await listConnectedTenants(fresh.access_token)
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not list Xero organisations: ${e?.message || e}` }, { status: 502 })
  }

  const existing = await loadExisting(db)
  const { free, taken } = classifyTenants(tenants, existing, locationId)
  return NextResponse.json({
    success: true,
    data: {
      current_tenant_id: conn.tenant_id,
      // `taken` carries claimedBy so the UI can say WHY an org is unavailable
      // rather than just greying it out.
      available: free.map((t) => ({ tenant_id: t.tenantId, tenant_name: t.tenantName, tenant_type: t.tenantType })),
      unavailable: taken.map((t) => ({ tenant_id: t.tenantId, tenant_name: t.tenantName, claimed_by: t.claimedBy })),
    },
  })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!permitted(user)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const v = await validateBody(request, SelectSchema)
  if (!v.ok) return v.response
  const { location_id: locationId, tenant_id: tenantId } = v.data
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: conn } = await db
    .from('xero_connections')
    .select('tenant_id')
    .eq('location_id', locationId)
    .maybeSingle()
  if (!conn) return NextResponse.json({ success: false, error: 'This location has no Xero connection.' }, { status: 404 })
  if (conn.tenant_id === tenantId) {
    return NextResponse.json({ success: true, data: { changed: false, tenant_id: tenantId } })
  }

  let tenants
  try {
    const { conn: fresh } = await withFreshToken(locationId)
    tenants = await listConnectedTenants(fresh.access_token)
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not list Xero organisations: ${e?.message || e}` }, { status: 502 })
  }

  const existing = await loadExisting(db)
  const choice = validateTenantChoice(tenantId, tenants, existing, locationId)
  if (!choice.ok) return NextResponse.json({ success: false, error: choice.error }, { status: 409 })

  const { error: upErr } = await db
    .from('xero_connections')
    .update({
      tenant_id: choice.tenant.tenantId,
      tenant_name: choice.tenant.tenantName,
      tenant_type: choice.tenant.tenantType,
      // The caches below are about to be emptied; clear the "last synced"
      // stamps too so the UI cannot claim a sync that no longer describes
      // this connection.
      accounts_last_synced_at: null,
      contacts_last_synced_at: null,
      tax_rates_last_synced_at: null,
    })
    .eq('location_id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  // Purge the org-specific caches. Every id in them belongs to the OLD org.
  const purged = {}
  for (const table of ['xero_accounts', 'xero_contacts', 'xero_tax_rates']) {
    const { error, count } = await db.from(table).delete({ count: 'exact' }).eq('location_id', locationId)
    purged[table] = error ? `error: ${error.message}` : (count ?? 0)
  }

  // Re-prime from the new org. Best-effort, exactly as the connect flow does:
  // the binding is already correct either way, and a sync failure is recorded
  // on the connection row rather than losing the switch.
  try { await pullAccounts(locationId) } catch (e) { console.warn(`[xero select-tenant] accounts sync: ${e?.message || e}`) }
  try { await pullTaxRates(locationId) } catch (e) { console.warn(`[xero select-tenant] tax-rate sync: ${e?.message || e}`) }

  return NextResponse.json({
    success: true,
    data: {
      changed: true,
      tenant_id: choice.tenant.tenantId,
      tenant_name: choice.tenant.tenantName,
      purged,
      // Said explicitly so nobody assumes the switch re-filed anything.
      note: 'Bills already pushed to the previous organisation were not moved.',
    },
  })
}
