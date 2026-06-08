// Regression guard for the mobile "View as user" leak.
//
// Every hand-rolled /api/* client wrapper must forward the
// x-impersonate-target header. When invoices-api.js hand-rolled its
// headers and dropped it, "View as Colm" (a staff contractor) reached
// /api/invoices as the real master and showed the master's whole
// UN1T Stillorgan invoice queue — including another contractor's
// submitted invoice. This test runs each client's read call with an
// active impersonation blob and asserts the header rides along, so the
// whole class can't silently regress.
//
// RN modules (expo-constants, ./supabase, ./impersonate) are fully
// mocked, so nothing native loads — safe under vitest's Node env.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiBaseUrl: 'https://test.local' } } },
}))

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt-master' } } }),
    },
  },
}))

vi.mock('./impersonate', () => ({
  // Master is viewing as Colm.
  readImpersonate: async () => ({ targetId: 'colm-uuid', startedAt: '2026-06-08T11:33:08.000Z' }),
}))

// Static imports (vi.mock is hoisted above these) — one representative
// read call per client wrapper. All six previously hand-rolled their
// headers; all six must now forward impersonation.
import { listInvoices } from './invoices-api'
import { listExpenseClaims } from './expenses-api'
import { listContracts } from './contracts-api'
import { getTodayChecklists } from './checklists-api'
import { listMyIssues } from './issues-api'
import { listPolicies } from './policies-api'

const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: [] }) }))

beforeEach(() => {
  fetchMock.mockClear()
  global.fetch = fetchMock
})

const READ_CALLS = [
  ['invoices-api.listInvoices', listInvoices],
  ['expenses-api.listExpenseClaims', listExpenseClaims],
  ['contracts-api.listContracts', listContracts],
  ['checklists-api.getTodayChecklists', getTodayChecklists],
  ['issues-api.listMyIssues', listMyIssues],
  ['policies-api.listPolicies', listPolicies],
]

describe('mobile /api clients forward x-impersonate-target during "View as user"', () => {
  for (const [name, fn] of READ_CALLS) {
    it(`${name}() sends the impersonation header (not the master's own view)`, async () => {
      await fn()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] || {}
      expect(init.headers['x-impersonate-target']).toBe('colm-uuid')
      expect(init.headers.Authorization).toBe('Bearer jwt-master')
    })
  }
})
