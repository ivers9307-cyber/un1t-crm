// INBOXFOLLOW.4 — the phone's Instagram snooze call.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

import { api } from './api'
import { snoozeConversation } from './instagram-api'

beforeEach(() => { vi.clearAllMocks() })

describe('snoozeConversation', () => {
  it('POSTs the body to the Instagram snooze route through api()', async () => {
    api.mockResolvedValue({ success: true })
    await snoozeConversation('c1', { until: null }, 'loc-1')
    expect(api).toHaveBeenCalledWith('/api/instagram/conversations/c1/snooze', { method: 'POST', locationId: 'loc-1', body: { until: null } })
  })
})
