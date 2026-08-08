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
import { getTicket, getTicketCount } from './email-api'

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

// EMAIL-ASSIGN.1 — the mobile claim path. Mirrors the web contract exactly:
// 'me' | null | <profile id>, the route decides.
describe('assignTicket', () => {
  it("posts the assignee and passes the route's ticket + name back", async () => {
    api.mockResolvedValue({
      success: true,
      data: { ticket: { id: 'T-1', assigned_to: 'p-1' }, assignee_name: 'Casey' },
    })
    const { assignTicket } = await import('./email-api')
    const res = await assignTicket('T-1', 'me', { locationId: 'loc-1' })
    expect(res.success).toBe(true)
    expect(res.ticket.assigned_to).toBe('p-1')
    expect(res.assigneeName).toBe('Casey')
    expect(api).toHaveBeenCalledWith('/api/email/tickets/T-1/assign', expect.objectContaining({
      method: 'POST', locationId: 'loc-1', body: { assignee: 'me' },
    }))
  })

  it('surfaces a refusal as a failure with the code intact', async () => {
    api.mockResolvedValue({ success: false, error: 'already_assigned' })
    const { assignTicket } = await import('./email-api')
    const res = await assignTicket('T-1', 'me', { locationId: 'loc-1' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('already_assigned')
  })
})

// EMAIL-BADGE-M.1 — the Email tab badge count. The endpoint exists precisely
// so this surface never polls the whole 200-row queue for a number
// (EMAIL-TICKET-CLEANUP.3); the wrapper's job is the right path + the
// location header, and passing failure through so the poller can keep its
// last-known count instead of flashing a confident zero.
describe('getTicketCount', () => {
  it('asks the cheap count route, location-scoped', async () => {
    api.mockResolvedValue({ success: true, data: { count: 4 } })
    const res = await getTicketCount('loc-1')
    expect(api).toHaveBeenCalledWith('/api/email/tickets/count', { locationId: 'loc-1' })
    expect(res).toEqual({ success: true, data: { count: 4 } })
  })

  it('passes a failure through untouched — the poller keeps its last count', async () => {
    api.mockResolvedValue({ success: false, error: 'blip' })
    const res = await getTicketCount('loc-1')
    expect(res.success).toBe(false)
  })
})
