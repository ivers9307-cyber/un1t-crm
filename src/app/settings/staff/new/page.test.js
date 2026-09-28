// SECFIX.3a — /settings/staff/new hands every active location to StaffForm,
// a client component, so the rows are serialised into the page. It read them
// with select('*'): each studio's stored credentials went with them. The
// prop is redacted; presence (StaffForm.isUnifiConfigured) survives as the mask.
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import NewStaffPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { LOCATION_SECRET_MASK } from '@/lib/location-secrets'

const LOC = 'a0000000-0000-0000-0000-000000000001'

function makeDb(locationRows) {
  return {
    from: (table) => {
      const chain = {}
      for (const op of ['select', 'eq', 'order']) chain[op] = () => chain
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

describe('/settings/staff/new — SECFIX.3a: the locations prop carries no credential', () => {
  it('hands StaffForm masked locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true, role: 'master', rolesByLocation: {} })
    createServerClient.mockReturnValue(makeDb([{
      id: LOC, name: 'Studio', sensibo_api_key: 'SYNTH-S', thinq_pat: 'SYNTH-T',
      settings: { glofox: { branch_id: 'b1', api_key: 'SYNTH-GK' }, unifi: { host: 'https://unifi.example', api_token: 'SYNTH-UT' } },
    }]))

    const el = findElement(await NewStaffPage(), 'StaffForm')
    expect(el).toBeTruthy()
    expect(JSON.stringify(el.props.locations)).not.toMatch(/SYNTH-/)
    expect(el.props.locations[0].settings.unifi.api_token).toBe(LOCATION_SECRET_MASK)
    expect(el.props.callerOwnerLocationIds).toEqual([LOC])
  })
})
