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
})
