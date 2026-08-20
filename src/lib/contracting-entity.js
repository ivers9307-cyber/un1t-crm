// LEGALENT.1 — resolve the CONTRACTING legal entity for a contract.
//
// A countersignature block ("For X"), a contract's party clause and a
// contract email footer all assert the COMPANY that is contracting.
// That is a legal-entity claim, not branding, and on every one of
// those surfaces it was hard-coded to a company formed from the gym
// brand that does not appear in any register — while the public legal
// pages have named the settled entity, Champ Fitness Ltd (trading as
// UN1T Dublin), since SAAS4-W0.2.
//
// Two rules shape this helper:
//
//   1. CLAUDE.md — customer-facing copy must be operator-editable
//      (settings field + default fallback), not a literal. The field
//      already exists: `org_settings.legal_entity_name` /
//      `legal_trading_name` (mig 425, edited on the org branding
//      settings card). No migration is needed to use it.
//
//   2. Every business in this estate is a SEPARATE legal entity
//      (CLAUDE.md's Xero invariant: Champ Fitness Ltd, CCF Autos,
//      Givers Consultancy, SourceIt). Contracts are org-scoped, so the
//      default fallback must NEVER assert one org's company on
//      another's document. That is why the fallback here is the
//      resolved BRAND name (getLocationBranding: location ->
//      organisation -> 'UN1T'), which claims no registered company,
//      and not the gym's settled entity string. An unconfigured org
//      renders an under-specified label; it can never render the wrong
//      company. Configure `org_settings.legal_entity_name` per
//      organisation to make it exact.
//
// The stored signed PDF (src/lib/contract-pdf.js) has always labelled
// its countersignature `For ${companyName}` from the same branding
// resolver, so this also ends the divergence where the screen said one
// company and the PDF said another.

import { getLocationBranding } from './location-branding.js'

// Mirrors location-branding.js's own default so the pure function can
// be used without a branding lookup.
const DEFAULT_BRAND = 'UN1T'

/**
 * Pure: shape a contracting-entity label from whatever is configured.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.legalEntityName]  org_settings.legal_entity_name
 * @param {string|null} [opts.legalTradingName] org_settings.legal_trading_name
 * @param {string|null} [opts.companyName]      resolved brand (getLocationBranding)
 * @returns {string} always a non-empty string
 */
export function contractingEntityLabel({ legalEntityName, legalTradingName, companyName } = {}) {
  const entity = String(legalEntityName ?? '').trim()
  const trading = String(legalTradingName ?? '').trim()
  const brand = String(companyName ?? '').trim()
  if (entity) {
    if (trading && trading.toLowerCase() !== entity.toLowerCase()) {
      return `${entity} (trading as ${trading})`
    }
    return entity
  }
  return brand || DEFAULT_BRAND
}

/**
 * Resolve the contracting entity for one contract.
 *
 * Never throws and never returns an empty label — a settings miss on a
 * contract surface must degrade to the brand, not blank the party name
 * on a document someone is about to sign.
 *
 * @param {object|null} db a supabase-js client (service role)
 * @param {object} [opts]
 * @param {string|null} [opts.organizationId] the contract's organization_id
 * @param {string|null} [opts.locationId]     the contract's location_id
 * @param {object|null} [opts.branding]       pre-resolved getLocationBranding() result
 * @returns {Promise<{ label: string, entityName: string|null, tradingName: string|null, companyName: string }>}
 */
export async function getContractingEntity(db, { organizationId = null, locationId = null, branding = null } = {}) {
  let resolvedBranding = branding
  if (!resolvedBranding) {
    resolvedBranding = await getLocationBranding(db, locationId)
  }
  const companyName = resolvedBranding?.companyName || DEFAULT_BRAND

  let entityName = null
  let tradingName = null
  if (db) {
    try {
      let orgId = organizationId
      if (!orgId && locationId) {
        const { data: locRows, error: locErr } = await db
          .from('locations')
          .select('organization_id')
          .eq('id', locationId)
          .limit(1)
        orgId = (!locErr && locRows?.[0]?.organization_id) || null
      }
      if (orgId) {
        const { data: rows, error } = await db
          .from('org_settings')
          .select('legal_entity_name, legal_trading_name')
          .eq('organization_id', orgId)
          .limit(1)
        const row = (!error && rows?.[0]) || null
        entityName = (row?.legal_entity_name || '').trim() || null
        tradingName = (row?.legal_trading_name || '').trim() || null
      }
    } catch {
      // Swallow: an unreadable org_settings row must degrade to the
      // brand label, not break the contract page / email / issue path.
      entityName = null
      tradingName = null
    }
  }

  return {
    label: contractingEntityLabel({ legalEntityName: entityName, legalTradingName: tradingName, companyName }),
    entityName,
    tradingName,
    companyName,
  }
}
