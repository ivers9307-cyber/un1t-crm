// SECFIX.3a — /admin/matrix (master-only) hands every active location to two
// client components (AdminFeatureMatrix, AdminAccessMatrix), so the rows are
// serialised into the page. It read them with select('*'): every studio's
// stored credentials went with them. The rows are redacted before grouping.
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import AdminMatrixPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { CLIENT_LOCATION_COLUMNS } from '@/lib/location-secrets'

const ORG = 'c0000000-0000-0000-0000-000000000003'

function makeDb(rows) {
  return {
    from: (table) => {
      const chain = {}
      for (const op of ['select', 'eq', 'order']) chain[op] = () => chain
      chain.then = (res) => Promise.resolve({ data: rows[table] || [] }).then(res)
      return chain
    },
  }
}

function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const f = findElement(n, name); if (f) return f }
    return null
  }
  const t = node.type
  if (t && (t.name === name || t.displayName === name)) return node
  return findElement(node.props?.children, name)
}

describe('/admin/matrix — SECFIX.3a: neither matrix receives a location credential', () => {
  it('both matrices get masked locations, grouped by organisation as before', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true, profileRole: 'master' })
    createServerClient.mockReturnValue(makeDb({
      organizations: [{ id: ORG, name: 'Org', active: true }],
      locations: [{
        id: 'loc-1', name: 'Studio', organization_id: ORG, features: {},
        sensibo_api_key: 'SYNTH-S', thinq_pat: 'SYNTH-T',
        bca_config: { k: 'SYNTH-BCA' }, monthly_contractor_budget_eur: 1234,
        settings: { glofox: { api_key: 'SYNTH-GK', api_token: 'SYNTH-GT' }, unifi: { api_token: 'SYNTH-UT' }, customer_agent: { test_phones: ['+353000000000'] } },
      }],
      profiles: [],
    }))

    const tree = await AdminMatrixPage()
    for (const name of ['AdminFeatureMatrix', 'AdminAccessMatrix']) {
      const el = findElement(tree, name)
      expect(el, name).toBeTruthy()
      expect(el.props.locationsByOrg[ORG].map((l) => l.id)).toEqual(['loc-1'])
      expect(JSON.stringify(el.props.locationsByOrg), name).not.toMatch(/SYNTH-/)
      // STAFFPROFILEPICK.1 — identity columns only: no settings (test phones),
      // no budget, no config column.
      const [loc] = el.props.locationsByOrg[ORG]
      for (const k of Object.keys(loc)) expect(CLIENT_LOCATION_COLUMNS, `${name}: ${k}`).toContain(k)
      expect(loc).toMatchObject({ id: 'loc-1', name: 'Studio', features: {} })
      expect(JSON.stringify(el.props.locationsByOrg)).not.toMatch(/test_phones|\+353000000000/)
    }
  })
})
