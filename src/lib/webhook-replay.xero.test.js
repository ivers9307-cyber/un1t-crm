// XEROHOOK.1 — the Xero replayer re-runs the event and throws while it still
// cannot be recorded, so the dead-letter row backs off and retries.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/xero/webhook-events', () => ({ processXeroInvoiceEvent: vi.fn() }))
const { processXeroInvoiceEvent } = await import('@/lib/xero/webhook-events')
const { replayXero, isReplayable } = await import('./webhook-replay.js')

describe('replayXero', () => {
  it('is an automatic replayer', () => { expect(isReplayable('xero')).toBe(true) })
  it('resolves once the event is recorded or ignored', async () => {
    processXeroInvoiceEvent.mockResolvedValueOnce({ status: 'processed' }).mockResolvedValueOnce({ status: 'ignored' })
    await expect(replayXero({}, { resourceId: 'x' })).resolves.toBeUndefined()
    await expect(replayXero({}, { resourceId: 'x' })).resolves.toBeUndefined()
  })
  it('throws while it still fails', async () => {
    processXeroInvoiceEvent.mockResolvedValueOnce({ status: 'failed', reason: 'xero_fetch_failed', error: new Error('token') })
    await expect(replayXero({}, { resourceId: 'x' })).rejects.toThrow(/xero_fetch_failed/)
  })
})
