import { describe, it, expect } from 'vitest'
import { XERO_SCOPES } from './client'

// Xero's 2026 granular-scope migration RETIRED the broad scopes below.
// An app on the granular regime that requests one is rejected at the
// AUTHORIZE step — Xero renders its generic "Sorry, something went
// wrong" page and the operator can never (re)connect. This bit us in
// prod on 2026-07-04 ('accounting.reports.read', shipped in RCOV.P0):
// every scope added here must come from Xero's CURRENT granular
// catalog, and this test is the tripwire.
const RETIRED_BROAD_SCOPES = ['accounting.transactions', 'accounting.reports.read']

// A second failure class, same blast radius: ENTITLEMENT-GATED scopes.
// The Finance API (finance.*) is restricted to Xero-approved apps
// (lending use-cases) — a standard app requesting one fails AUTHORIZE
// with "invalid_scope / Error code: 500". Hit live 2026-07-04 with
// finance.bankstatementsplus.read: the scope string is real (it's in
// xero-finance.yaml), but spec-existence ≠ app entitlement.
const ENTITLEMENT_GATED_SCOPES = ['finance.bankstatementsplus.read']

describe('XERO_SCOPES', () => {
  it('never requests a retired broad scope (breaks the authorize step)', () => {
    for (const retired of RETIRED_BROAD_SCOPES) {
      expect(XERO_SCOPES, `${retired} is retired — granular regime rejects it at authorize`)
        .not.toContain(retired)
    }
  })

  it('requests the granular bank-transactions read scope for the coverage pull', () => {
    expect(XERO_SCOPES).toContain('accounting.banktransactions.read')
  })

  it('never requests an entitlement-gated finance.* scope (app not approved — breaks authorize)', () => {
    for (const gated of ENTITLEMENT_GATED_SCOPES) {
      expect(XERO_SCOPES, `${gated} is Finance-API-gated — this app is not entitled to it`)
        .not.toContain(gated)
    }
    expect(XERO_SCOPES.some((s) => s.startsWith('finance.'))).toBe(false)
  })
})
