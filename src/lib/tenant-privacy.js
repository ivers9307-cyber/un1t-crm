// SAAS4-C2 — per-tenant privacy-notice entity resolution (SaaS
// machinery plan §6). Each tenant gym is the CONTROLLER of its
// members' data, so the public privacy notice served on a tenant's
// hostname must carry THEIR legal entity — not Champ Fitness Ltd,
// who is the processor.
//
// The load-bearing rule: a half-configured tenant renders the
// PLATFORM copy, never a legal page with blanks. Entity name and
// privacy contact email are the minimum for a servable notice
// (shapeTenantPrivacyEntity returns null otherwise), and any
// resolution error falls back the same way.

import { createServerClient } from '@/lib/supabase'
import { resolveTenantOrgId } from '@/lib/tenant-domains-edge'

/** Pure: org_settings row → renderable entity, or null if unservable. */
export function shapeTenantPrivacyEntity(row) {
  const entityName = row?.legal_entity_name?.trim()
  const contactEmail = row?.privacy_contact_email?.trim()
  if (!entityName || !contactEmail) return null
  return {
    entityName,
    tradingName: row.legal_trading_name?.trim() || null,
    address: row.legal_address?.trim() || null,
    contactEmail,
  }
}

/**
 * Resolve the privacy entity for a request host. Returns null for
 * non-tenant hosts, unconfigured tenants, or any error — callers
 * render the platform (Champ Fitness Ltd) copy in every null case.
 */
export async function getTenantPrivacyEntity(host, { db, resolveOrg } = {}) {
  try {
    const orgId = await (resolveOrg || resolveTenantOrgId)(host)
    if (!orgId) return null
    const client = db || createServerClient()
    const { data } = await client
      .from('org_settings')
      .select('legal_entity_name, legal_trading_name, legal_address, privacy_contact_email')
      .eq('organization_id', orgId)
      .maybeSingle()
    return shapeTenantPrivacyEntity(data)
  } catch {
    return null
  }
}
