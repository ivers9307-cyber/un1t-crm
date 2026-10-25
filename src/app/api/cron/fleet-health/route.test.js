import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/tailscale-api', () => ({
  tailscaleConfigured: vi.fn(() => false),
  listTailnetDevices: vi.fn(),
}))
vi.mock('@/lib/location-time', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocationZones: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/fleet-screen-health', () => ({ runScreenHealth: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn() })) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { GET } from './route.js'
import { tailscaleConfigured, listTailnetDevices } from '@/lib/tailscale-api'
import { runScreenHealth } from '@/lib/fleet-screen-health'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createServerClient } from '@/lib/supabase'

process.env.CRON_SECRET = 'test-secret'

const authed = () => new Request('http://t/api/cron/fleet-health', {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
})

describe('fleet-health cron — screen pass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tailscaleConfigured.mockReturnValue(false)
    runScreenHealth.mockResolvedValue({ checked: 6, alerted: 1 })
  })

  it('401s without the bearer, and runs nothing', async () => {
    const res = await GET(new Request('http://t/api/cron/fleet-health'))
    expect(res.status).toBe(401)
    expect(runScreenHealth).not.toHaveBeenCalled()
  })

  it('runs the screen pass even when Tailscale is unconfigured and reports its counts', async () => {
    const res = await GET(authed())
    expect(runScreenHealth).toHaveBeenCalledTimes(1)
    expect(runScreenHealth.mock.calls[0][1]).toMatchObject({ nowMs: expect.any(Number), notify: expect.any(Function) })
    expect((await res.json()).data).toMatchObject({ configured: false, checked: 0, screens_checked: 6, screens_alerted: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('fleet-health', expect.objectContaining({
      configured: false, screens_checked: 6, screens_alerted: 1,
    }))
  })

  it('runs the screen pass before Tailscale is consulted', async () => {
    const order = []
    runScreenHealth.mockImplementation(async () => { order.push('screens'); return { checked: 0, alerted: 0 } })
    tailscaleConfigured.mockImplementation(() => { order.push('tailscale'); return false })
    await GET(authed())
    expect(order).toEqual(['screens', 'tailscale'])
  })

  it('stamps the screen counts on the no-fleet-tag early return too', async () => {
    tailscaleConfigured.mockReturnValue(true)
    listTailnetDevices.mockResolvedValue([])
    const res = await GET(authed())
    expect((await res.json()).data).toMatchObject({ checked: 0, tagged: 0, screens_checked: 6, screens_alerted: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('fleet-health', expect.objectContaining({
      tagged: 0, screens_checked: 6, screens_alerted: 1,
    }))
  })

  it('still reports the screen counts when Tailscale is unreachable, and skips the heartbeat', async () => {
    tailscaleConfigured.mockReturnValue(true)
    listTailnetDevices.mockRejectedValue(new Error('tailscale 503'))
    const res = await GET(authed())
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'tailscale_unreachable', screens_checked: 6, screens_alerted: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('fleet-health cron — Pi pass', () => {
  // A chainable fake: every builder method returns the chain, awaiting it
  // resolves per table, and upserts are recorded.
  function fakeDb(tables) {
    const upserts = []
    const from = (table) => {
      const q = {}
      for (const m of ['select', 'eq', 'in', 'is', 'not', 'lt', 'lte', 'gt', 'gte', 'order', 'limit', 'update']) {
        q[m] = () => q
      }
      q.upsert = (rows) => { upserts.push({ table, rows }); return q }
      q.then = (resolve) => resolve({ data: tables[table] ?? [], error: null })
      return q
    }
    return { client: { from, storage: { from: () => ({ remove: async () => ({ error: null }) }) } }, upserts }
  }

  it('does not grade a tailnet device whose fleet role is screen (the screen pass owns it)', async () => {
    tailscaleConfigured.mockReturnValue(true)
    runScreenHealth.mockResolvedValue({ checked: 0, alerted: 0 })
    listTailnetDevices.mockResolvedValue([
      { hostname: 'hatch-screen1', tags: ['tag:un1t-pi'], connectedToControl: true },
      { hostname: 'stillorgan-tv1', tags: ['tag:un1t-pi'], connectedToControl: true },
    ])
    const { client, upserts } = fakeDb({
      fleet_devices: [
        { device_name: 'hatch-screen1', role: 'screen', last_render_at: null, location_id: null },
        { device_name: 'stillorgan-tv1', role: 'kiosk', last_render_at: null, location_id: null },
      ],
    })
    createServerClient.mockReturnValueOnce(client)
    const res = await GET(authed())
    expect((await res.json()).data).toMatchObject({ checked: 1 })
    const healthRows = upserts.filter((u) => u.table === 'fleet_device_health').flatMap((u) => u.rows)
    expect(healthRows.map((r) => r.device_name)).toEqual(['stillorgan-tv1'])
  })
})
