// PROFILESPREAD.1 (F6) — /automations/shelly reads Glofox presence itself
// (the user object no longer carries settings). A failed read shows a notice
// and never claims "not connected". Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), guardMasterOrOwner: () => null }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn((u, k) => k === 'device_control') }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: () => { throw new Error('the page itself must not query') } })) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/automations/glofox-status', () => ({ readGlofoxAutomationStatus: vi.fn() }))
vi.mock('@/components/automations/ShellyDevicesClient', () => ({ default: (p) => <div>{`shelly:${p.glofoxConnected}:unknown=${p.glofoxUnknown}`}</div> }))

import ShellyPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { readGlofoxAutomationStatus } from '@/lib/automations/glofox-status'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const NOTICE = /role="alert"[^>]*>[^<]*Couldn(?:&#x27;|')t check whether Glofox is connected, so class-linked schedules are unavailable until you reload\./

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: LOC, name: 'Studio', timezone: 'Europe/Dublin' }, locations: [{ id: LOC, name: 'Studio' }] })
})

describe('/automations/shelly — Glofox presence (PROFILESPREAD.1)', () => {
  it('known connected: class mode offered, no notice', async () => {
    readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: true, statuses: {} })
    const html = renderToStaticMarkup(await ShellyPage())
    expect(readGlofoxAutomationStatus).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(html).toContain('shelly:true:unknown=false')
    expect(html).not.toMatch(/Couldn(?:&#x27;|')t check/)
  })

  it('unknown: class mode off, with a notice that says why', async () => {
    readGlofoxAutomationStatus.mockResolvedValue({ known: false, connected: null, statuses: {} })
    const html = renderToStaticMarkup(await ShellyPage())
    expect(html).toContain('shelly:false:unknown=true')
    expect(html).toMatch(NOTICE)
  })

  it('known not connected: class mode off, not unknown, no notice', async () => {
    readGlofoxAutomationStatus.mockResolvedValue({ known: true, connected: false, statuses: {} })
    const html = renderToStaticMarkup(await ShellyPage())
    expect(html).toContain('shelly:false:unknown=false')
    expect(html).not.toMatch(/Couldn(?:&#x27;|')t check/)
  })
})
