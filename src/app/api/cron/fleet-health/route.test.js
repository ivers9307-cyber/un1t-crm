import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/tailscale-api', () => ({
  tailscaleConfigured: vi.fn(() => false),
  listTailnetDevices: vi.fn(),
}))
vi.mock('@/lib/fleet-screen-health', () => ({ runScreenHealth: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn() })) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { GET } from './route.js'
import { tailscaleConfigured, listTailnetDevices } from '@/lib/tailscale-api'
import { runScreenHealth } from '@/lib/fleet-screen-health'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

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

  it('still reports the screen counts when Tailscale is unreachable, and skips the heartbeat', async () => {
    tailscaleConfigured.mockReturnValue(true)
    listTailnetDevices.mockRejectedValue(new Error('tailscale 503'))
    const res = await GET(authed())
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'tailscale_unreachable', screens_checked: 6, screens_alerted: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
