// SECFIX.3a — /settings/staff/new hands every active location to StaffForm,
// a client component, so the rows are serialised into the page. It read them
// with select('*'): the rows carried every studio's settings (credentials
// masked by SECFIX.3a, but test phones and config in clear).
// STAFFFORMSETTINGS.1: the prop is the identity + unifi_configured.
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import NewStaffPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001'

function makeDb(locationRows) {
  return {
    from: (table) => {
      const chain = {}
      for (const op of ['select', 'eq', 'order', 'in']) chain[op] = () => chain
      chain.then = (res) => Promise.resolve({ data: table === 'locations' ? locationRows : [] }).then(res)
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

describe('/settings/staff/new — STAFFFORMSETTINGS.1: StaffForm gets identity + unifi_configured, never settings', () => {
  it('hands StaffForm no settings, no test phone and no credential, and a UniFi boolean', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true, role: 'master', rolesByLocation: {} })
    createServerClient.mockReturnValue(makeDb([{
      id: LOC, name: 'Studio', slug: 'studio', features: {}, sensibo_api_key: 'SYNTH-S', thinq_pat: 'SYNTH-T',
      settings: {
        glofox: { branch_id: 'b1', api_key: 'SYNTH-GK' },
        unifi: { host: 'https://unifi.example.test', api_token: 'SYNTH-UT', staff_policy_id: 'p1', manager_policy_id: 'p2' },
        customer_agent: { enabled: true, test_phones: ['+353000000000'] },
      },
    }]))

    const el = findElement(await NewStaffPage(), 'StaffForm')
    expect(el).toBeTruthy()
    const [loc] = el.props.locations
    expect(loc).not.toHaveProperty('settings')
    expect(loc.unifi_configured).toBe(true)
    expect(loc).toMatchObject({ id: LOC, name: 'Studio', slug: 'studio' })
    expect(JSON.stringify(el.props.locations)).not.toMatch(/SYNTH-|\+353000000000|test_phones/)
    expect(el.props.callerOwnerLocationIds).toEqual([LOC])
  })
})
