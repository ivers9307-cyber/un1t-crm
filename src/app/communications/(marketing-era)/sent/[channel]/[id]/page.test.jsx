// @vitest-environment jsdom
//
// COMMS-IA.1 — the consolidated send-detail route.
//
// The Sends table used to exit into three unrelated chromes: SMS at
// /communications/sms/broadcasts/[id] (in the Communications shell), WhatsApp
// at /whatsapp/broadcasts/[id] (bare, outside it) and email at
// /email/campaigns/[id] (full viewport). All three now resolve here, so this
// one file carries the auth gate, the per-channel permission gate and the
// IDOR guard for every channel. The tests below are the guard tests: an
// unknown channel is a 404, a missing permission bounces to the hub, and a
// row at another location is a 404 (never a 403 — foreign ids stay
// non-enumerable, per CLAUDE.md).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('@/components/SMSBroadcastEditor', () => ({ default: () => <div data-testid="sms-body" /> }))
vi.mock('@/components/WABroadcastEditor', () => ({ default: () => <div data-testid="wa-body" /> }))
vi.mock('@/components/CampaignDetail', () => ({ default: () => <div data-testid="email-detail" /> }))
vi.mock('@/components/CampaignEditor', () => ({ default: () => <div data-testid="email-editor" /> }))
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: async (_db, row) => row }))
vi.mock('@/lib/whatsapp-drip', () => ({ dripWindowStatus: () => ({ state: 'open' }) }))
vi.mock('@/lib/campaign-display-stats', () => ({
  loadCampaignRecipientStats: async () => ({}),
  campaignDisplayStats: () => ({ recipients: 0, sent: 0, bounced: 0 }),
}))

import SendDetailPage from './page.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// Any builder method returns the chain; awaiting it, or calling
// single()/maybeSingle(), yields the row this table was seeded with.
function chain(result) {
  const o = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve) => resolve(result)
      if (prop === 'single' || prop === 'maybeSingle') return async () => result
      return () => o
    },
  })
  return o
}

function dbWith(byTable) {
  return {
    from: (table) => chain(byTable[table] ?? { data: null, count: 0 }),
    rpc: async () => ({ data: [] }),
  }
}

const SMS_ROW = { id: 's1', name: 'Blast', status: 'sent', location_id: 'loc-1', locations: { id: 'loc-1', name: 'Stillorgan' } }
const WA_ROW = { id: 'b1', name: 'Blast', status: 'sent', location_id: 'loc-1', delivery_mode: 'bulk', whatsapp_broadcast_recipients: [] }
const CAMPAIGN_ROW = { id: 'c1', name: 'Spring', status: 'sent', location_id: 'loc-1' }

function args(channel, id, searchParams = {}) {
  return { params: Promise.resolve({ channel, id }), searchParams: Promise.resolve(searchParams) }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' } })
  hasPermission.mockReturnValue(true)
  assertLocationAccess.mockReturnValue(null)
  createServerClient.mockReturnValue(dbWith({
    sms_broadcasts: { data: SMS_ROW },
    whatsapp_broadcasts: { data: WA_ROW },
    campaigns: { data: CAMPAIGN_ROW },
  }))
})

describe('/communications/sent/[channel]/[id] — routing', () => {
  it('404s an unknown channel rather than guessing one', async () => {
    await expect(SendDetailPage(args('carrier-pigeon', 'x1'))).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('sends a signed-out visitor to /login', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(SendDetailPage(args('sms', 's1'))).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })
})

describe('/communications/sent/[channel]/[id] — per-channel gates', () => {
  for (const [channel, id, permission] of [['sms', 's1', 'sms'], ['whatsapp', 'b1', 'whatsapp'], ['email', 'c1', 'email']]) {
    it(`${channel}: bounces to the hub without the ${permission} permission`, async () => {
      hasPermission.mockImplementation((_u, key) => key !== permission)
      await expect(SendDetailPage(args(channel, id))).rejects.toThrow(/^NEXT_REDIRECT:\/communications$/)
    })

    it(`${channel}: 404s a row at another location (never 403)`, async () => {
      assertLocationAccess.mockReturnValue({ status: 403 })
      await expect(SendDetailPage(args(channel, id))).rejects.toThrow('NEXT_NOT_FOUND')
    })

    it(`${channel}: 404s a row that does not exist`, async () => {
      createServerClient.mockReturnValue(dbWith({}))
      await expect(SendDetailPage(args(channel, id))).rejects.toThrow('NEXT_NOT_FOUND')
    })
  }
})

describe('/communications/sent/[channel]/[id] — bodies stay distinct', () => {
  it('renders the SMS body for the sms channel', async () => {
    render(await SendDetailPage(args('sms', 's1')))
    expect(screen.getByTestId('sms-body')).toBeTruthy()
  })

  it('renders the WhatsApp body for the whatsapp channel', async () => {
    render(await SendDetailPage(args('whatsapp', 'b1')))
    expect(screen.getByTestId('wa-body')).toBeTruthy()
  })

  it('renders the campaign report for a sent email campaign', async () => {
    render(await SendDetailPage(args('email', 'c1')))
    expect(screen.getByTestId('email-detail')).toBeTruthy()
  })

  it('renders the campaign editor for a draft', async () => {
    createServerClient.mockReturnValue(dbWith({ campaigns: { data: { ...CAMPAIGN_ROW, status: 'draft' } } }))
    render(await SendDetailPage(args('email', 'c1')))
    expect(screen.getByTestId('email-editor')).toBeTruthy()
  })

  it('renders the campaign editor when ?edit=1 is on a DRAFT', async () => {
    createServerClient.mockReturnValue(dbWith({ campaigns: { data: { ...CAMPAIGN_ROW, status: 'draft' } } }))
    render(await SendDetailPage(args('email', 'c1', { edit: '1' })))
    expect(screen.getByTestId('email-editor')).toBeTruthy()
  })

  it('renders the campaign editor when ?edit=1 is on a SCHEDULED campaign', async () => {
    createServerClient.mockReturnValue(dbWith({ campaigns: { data: { ...CAMPAIGN_ROW, status: 'scheduled' } } }))
    render(await SendDetailPage(args('email', 'c1', { edit: '1' })))
    expect(screen.getByTestId('email-editor')).toBeTruthy()
  })

  // CAMPHIST.1 — the integrity hole. `?edit=1` opened the full editor on ANY
  // status, so a sent campaign could be overwritten while its recipients,
  // opens and clicks stayed pointed at it. The editor persists via the browser
  // Supabase client, so neither the PUT route's 409 nor RLS stopped it.
  it.each(['sent', 'sending', 'queued', 'cancelled', 'failed'])(
    'refuses to open the editor for a %s campaign, even with ?edit=1',
    async (status) => {
      createServerClient.mockReturnValue(dbWith({ campaigns: { data: { ...CAMPAIGN_ROW, status } } }))
      render(await SendDetailPage(args('email', 'c1', { edit: '1' })))
      expect(screen.queryByTestId('email-editor')).toBeNull()
      expect(screen.getByTestId('email-detail')).toBeTruthy()
    },
  )
})

// COMMS-DETAIL-FIX.5 — the SMS loader selected no contacts, so the recipients
// list had nothing but contact_id to render. FIX.1 — the WhatsApp loader now
// counts the recipient rows live for every finished broadcast, not only for a
// drip, so the stat cards and the failed-sends box read one source.
function recordingDb(byTable) {
  const selects = []
  const from = (table) => {
    const call = { table, selects: [], filters: [] }
    const o = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(byTable[table] ?? { data: null, count: 0 })
        if (prop === 'single' || prop === 'maybeSingle') return async () => byTable[table] ?? { data: null }
        return (...args) => {
          if (prop === 'select') { call.selects.push(args[0]); selects.push({ table, arg: args[0], opts: args[1] }) }
          if (prop === 'eq' || prop === 'in') call.filters.push([prop, ...args])
          return o
        }
      },
    })
    return o
  }
  return { db: { from, rpc: async () => ({ data: [] }) }, selects }
}

describe('/communications/sent/[channel]/[id] — the loaders feed the bodies real data', () => {
  it('joins the contact onto every SMS recipient row', async () => {
    const { db, selects } = recordingDb({ sms_broadcasts: { data: SMS_ROW } })
    createServerClient.mockReturnValue(db)
    await SendDetailPage(args('sms', 's1'))
    const recipSelect = selects.find(s => s.table === 'sms_broadcast_recipients')
    expect(recipSelect).toBeTruthy()
    expect(recipSelect.arg).toMatch(/contacts\s*\(/)
    expect(recipSelect.arg).toMatch(/name/)
    expect(recipSelect.arg).toMatch(/phone/)
  })

  it('counts WhatsApp recipient rows live even for a finished bulk broadcast', async () => {
    const { db, selects } = recordingDb({ whatsapp_broadcasts: { data: WA_ROW } })
    createServerClient.mockReturnValue(db)
    await SendDetailPage(args('whatsapp', 'b1'))
    const counts = selects.filter(s => s.table === 'whatsapp_broadcast_recipients' && s.opts?.head === true)
    // rows + sent + delivered + read + failed, all count-only.
    expect(counts.length).toBeGreaterThanOrEqual(5)
  })
})
