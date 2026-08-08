import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { broadcastTimerPing } from './timer-broadcast'

describe('broadcastTimerPing', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    global.fetch = vi.fn().mockResolvedValue({ ok: true })
  })
  afterEach(() => vi.restoreAllMocks())

  it('POSTs a broadcast message on the per-location topic', async () => {
    await broadcastTimerPing('loc-1')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/realtime/v1/api/broadcast')
    expect(opts.method).toBe('POST')
    expect(opts.headers.apikey).toBe('svc-key')
    const body = JSON.parse(opts.body)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].topic).toBe('timer:loc-1')
    expect(body.messages[0].event).toBe('timer')
  })

  it('swallows fetch failures (fire-and-forget — never blocks the mutation)', async () => {
    fetch.mockRejectedValue(new Error('realtime down'))
    await expect(broadcastTimerPing('loc-1')).resolves.toBeUndefined()
  })
})
