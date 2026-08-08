// The mobile wire layer for email tickets — until now the one untested module
// in the email footprint (2026-08-08 audit). The case that forced the file:
// GET /api/email/tickets/[id] returns `attachments_unavailable: true` when the
// attachment lookup failed, precisely so a client can say "attachments
// unknown" instead of the silent wrong answer "no attachments". Web honours it
// (AttachmentsUnavailableNotice); mobile dropped the flag on the floor, so a
// blipped lookup rendered every message as though the member sent no files —
// the exact operator-facing lie the route's header warns about.
//
// `./api` is mocked BEFORE import: it pulls the React-Native runtime, which
// must never load under vitest's Node environment (see vitest.config.js).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))

import { api } from './api'
import { getTicket } from './email-api'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getTicket', () => {
  it('passes attachments_unavailable through — a failed lookup must not read as "no attachments"', async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1' }, messages: [], attachments_unavailable: true },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.success).toBe(true)
    expect(res.attachmentsUnavailable).toBe(true)
  })

  it('reports false when the route omits the flag — the healthy case stays quiet', async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1' }, messages: [] },
    })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.attachmentsUnavailable).toBe(false)
  })

  it('still surfaces a failure as a failure', async () => {
    api.mockResolvedValue({ success: false, error: 'nope' })
    const res = await getTicket('T-1', 'loc-1')
    expect(res.success).toBe(false)
    expect(res.error).toBe('nope')
  })
})
