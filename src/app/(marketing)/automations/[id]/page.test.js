// SEC-AUTOMATION-BUILDER-GATE.1 — /automations/[id] (the sequence flow
// builder) had auth + tenant checks (login, then assertLocationAccess on
// the sequence's location) but NO permission gate — any logged-in staffer
// at the sequence's own location could open and edit the flow, regardless
// of whether they hold any automations-related permission.
//
// The /automations index only ever links here from AutomationsFlowList,
// which the index renders behind `canFlows = hasPermission('email') ||
// hasPermission('whatsapp')` — the curated-cards section (`automations`
// perm) and the Devices link (`device_control` perm) are unrelated
// surfaces that never route through this page. So the builder is gated
// on the same OR: `email` or `whatsapp`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

vi.mock('@/components/sequences/SequenceFlowBuilder', () => ({
  default: ({ sequence }) => <div data-testid="builder">{sequence.name}</div>,
}))
vi.mock('@/components/automations/AutomationPerformance', () => ({
  default: () => null,
}))

import SequenceBuilderPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function mockDb({ sequence = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: sequence,
            error: sequence ? null : { message: 'not found' },
          })),
        })),
      })),
    })),
  }
}

function user({ locations = [{ id: 'loc1' }], perms = {} } = {}) {
  return {
    id: 'u1',
    role: 'staff',
    locations,
    activeLocation: locations[0] || null,
    activeAssignment: {
      permissions: { automations: false, email: false, whatsapp: false, device_control: false, ...perms },
    },
  }
}

function props(id = 'seq1') {
  return { params: Promise.resolve({ id }) }
}

const mySequence = { id: 'seq1', location_id: 'loc1', name: 'Welcome flow', sequence_steps: [] }

beforeEach(() => vi.clearAllMocks())

describe('/automations/[id] builder page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / when the user holds none of email/whatsapp', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: false, whatsapp: false } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects to / for a device_control-only user (devices is a separate surface)', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { device_control: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects to / for an automations-only user (curated cards never link here)', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { automations: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('renders the builder for an email holder at the sequence location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Welcome flow')
  })

  it('renders the builder for a whatsapp holder at the sequence location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { whatsapp: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Welcome flow')
  })

  it('404s a missing sequence before the permission check can leak its existence either way', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: null }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s a foreign-location sequence even when the user holds email', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [{ id: 'loc1' }], perms: { email: true } }))
    createServerClient.mockReturnValue(
      mockDb({ sequence: { ...mySequence, location_id: 'loc9', name: 'Foreign flow' } })
    )
    await expect(SequenceBuilderPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
