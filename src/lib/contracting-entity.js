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
// Three rules shape this helper:
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
//      fallback chain must NEVER assert one org's company on another's
//      document — which is why the last resort before the neutral
//      default is the org's OWN name (`organizations.name`), not the
//      gym brand. Measured 2026-08-20: all three orgs have
//      legal_entity_name, legal_trading_name AND company_name NULL,
//      and all six locations have company_settings.company_name NULL,
//      so the brand resolver returns its literal 'UN1T' default for
//      every org in prod. Taking that as the entity label would print
//      the gym's brand on a CCF Autos contract — the exact failure
//      this helper exists to prevent. `organizations.name` IS
//      populated for all three, so it goes ahead of the literal.
//      W1.S1a removed that literal altogether (see below).
//
//   3. A countersignature label is part of the DOCUMENT, not page
//      chrome, so it must be FROZEN, not resolved live on every
//      render — see contractCountersignatureLabel() below.
//
// Resolution order for a NEW document:
//   org_settings.legal_entity_name (+ legal_trading_name)
//     -> operator-configured brand (company_settings / org_settings)
//     -> organizations.name
//     -> ''   (only reachable when even the org row is unreadable)
//
// W1.S1a (SaaS Wave 1, the literal sweep) dropped the old last resort, a
// fixed gym wordmark (the plan's appendix row contracting-entity.js:48,
// "drop"). W1.B1 had already removed the brand resolver's own literal, so
// that one only fired when the database was unreadable or absent, and in
// that state it asserted ONE gym as the contracting party on every other
// organisation's document: the precise failure this module exists to stop.
// The floor is now the organisation's own name; past it the label is
// honestly empty rather than wrong.

import { getLocationBranding } from './location-branding.js'

// The literal every contract issued BEFORE LEGALENT.1 was issued and
// signed under. It is retired for new documents, but a document that
// has already been issued said this, and rewriting an executed
// document's counterparty is not a bug fix — it is tampering. This is
// the ONE place in the shipped source allowed to name it, and
// tests/legal-entity-consistency.test.js exempts this file by name for
// exactly that reason.
export const LEGACY_COUNTERSIGNATURE_ENTITY = 'UN1T Dublin Ltd'

/**
 * Pure: shape a contracting-entity label from whatever is configured.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.legalEntityName]   org_settings.legal_entity_name
 * @param {string|null} [opts.legalTradingName]  org_settings.legal_trading_name
 * @param {string|null} [opts.companyName]       CONFIGURED brand, or null when
 *                                               the brand resolver only had its
 *                                               own literal default to offer
 * @param {string|null} [opts.organizationName]  organizations.name
 * @returns {string} '' only when nothing at all is known (W1.S1a: never a
 *   fixed gym's name)
 */
export function contractingEntityLabel({
  legalEntityName,
  legalTradingName,
  companyName,
  organizationName,
} = {}) {
  const entity = String(legalEntityName ?? '').trim()
  const trading = String(legalTradingName ?? '').trim()
  const brand = String(companyName ?? '').trim()
  const org = String(organizationName ?? '').trim()
  if (entity) {
    if (trading && trading.toLowerCase() !== entity.toLowerCase()) {
      return `${entity} (trading as ${trading})`
    }
    return entity
  }
  return brand || org || ''
}

/**
 * The countersignature label for ONE contract — frozen, not live.
 *
 * `contracts.variables_data` is written once, at issue, in the same
 * statement as `body_rendered` (mig 106: "Frozen at issue time …
 * immutable once the contract is issued"), and since LEGALENT.1 the
 * merged variable map it stores includes `legal_entity_name`. So a
 * contract issued from now on carries its counterparty frozen
 * alongside its body, and every surface that renders that contract —
 * the issuer page, the recipient page, the mobile signing screen and
 * the stored PDF — reads the same frozen string for the life of the
 * document. They cannot drift from each other, and they cannot drift
 * when an operator later edits org_settings.
 *
 * A row with no frozen entity predates LEGALENT.1: it was issued, and
 * possibly signed, under the retired literal, and that is what it must
 * keep rendering. Resolving those live would rewrite what an executed
 * document says about who it is with — twice over, in fact (first to
 * the brand, then again the moment the operator configures the entity)
 * — and for the two prod rows that carry the retired name inside their
 * own frozen body it would leave a party clause naming one company
 * beside a countersignature naming another. The remedy for a live,
 * unsigned contract naming the wrong company is to revoke and re-issue
 * it, which is an operator decision; it is not a silent chrome swap.
 *
 * @param {object|null} contract a contracts row (needs `variables_data`)
 * @returns {string} always a non-empty string
 */
export function contractCountersignatureLabel(contract) {
  const frozen = contract?.variables_data?.legal_entity_name
  const label = typeof frozen === 'string' ? frozen.trim() : ''
  return label || LEGACY_COUNTERSIGNATURE_ENTITY
}

/**
 * Resolve the contracting entity for a NEW contract (issue time), a
 * contract email footer, or any other live surface.
 *
 * Never throws. A settings miss on a contract surface degrades to a weaker
 * claim (the configured brand, then the organisation's own name); the label
 * is empty only when even the organisation row is unreadable, because past
 * that point any name would be a guess about who is contracting (W1.S1a).
 *
 * @param {object|null} db a supabase-js client (service role)
 * @param {object} [opts]
 * @param {string|null} [opts.organizationId] the contract's organization_id
 * @param {string|null} [opts.locationId]     the contract's location_id
 * @param {object|null} [opts.branding]       pre-resolved getLocationBranding() result
 * @returns {Promise<{ label: string, entityName: string|null, tradingName: string|null, companyName: string, organizationName: string|null }>}
 */
export async function getContractingEntity(db, { organizationId = null, locationId = null, branding = null } = {}) {
  let resolvedBranding = branding
  if (!resolvedBranding) {
    resolvedBranding = await getLocationBranding(db, locationId)
  }
  const resolvedName = String(resolvedBranding?.companyName ?? '').trim()
  // W1.S1a — the wordmark is whatever the brand chain resolved; '' when it
  // resolved nothing (no fixed gym name stands in).
  const companyName = resolvedName

  // Only an OPERATOR-CONFIGURED brand may stand in for the entity. Since
  // W1.B1 getLocationBranding ends in the LOCATION'S NAME when nobody set
  // a brand — a label, not a claim — and `companyNameConfigured` says
  // which tier answered, so the flag is read and the string is never
  // compared against a literal. The `??` arm keeps a pre-resolved
  // branding object from an older caller (no such field) working: with
  // no literal left in the resolver, a non-empty name there is configured.
  const configuredBrand = (
    resolvedBranding?.companyNameConfigured ?? Boolean(resolvedName)
  ) ? resolvedName : null

  let entityName = null
  let tradingName = null
  let organizationName = null
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

        const { data: orgRows, error: orgErr } = await db
          .from('organizations')
          .select('name')
          .eq('id', orgId)
          .limit(1)
        organizationName = (!orgErr && (orgRows?.[0]?.name || '').trim()) || null
      }
    } catch {
      // Swallow: an unreadable org_settings/organizations row must
      // degrade to a weaker label, not break the contract page /
      // email / issue path.
      entityName = null
      tradingName = null
      organizationName = null
    }
  }

  return {
    label: contractingEntityLabel({
      legalEntityName: entityName,
      legalTradingName: tradingName,
      companyName: configuredBrand,
      organizationName,
    }),
    entityName,
    tradingName,
    companyName,
    organizationName,
  }
}
