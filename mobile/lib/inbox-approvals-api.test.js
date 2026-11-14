// APPROVALSQ.2 — decideApproval passes `silent: true` only when asked.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer jwt' })),
  API_BASE: 'https://crm.example',
}))
vi.mock('./supabase', () => ({ supabase: {} }))

import { decideApproval } from './inbox-approvals-api'

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }))
  globalThis.fetch = fetchMock
})
const sentBody = () => fetchMock.mock.calls[0][1].body

describe('decideApproval', () => {
  it('body is unchanged without silent', async () => {
    await decideApproval('r1', 'declined', 'n')
    expect(sentBody()).toBe(JSON.stringify({ status: 'declined', decision_note: 'n' }))
    fetchMock.mockClear()
    await decideApproval('r1', 'approved')
    expect(sentBody()).toBe(JSON.stringify({ status: 'approved', decision_note: null }))
    fetchMock.mockClear()
    await decideApproval('r1', 'declined', null, { silent: false })
    expect(sentBody()).toBe(JSON.stringify({ status: 'declined', decision_note: null }))
  })
  it('adds silent: true only when silent is true', async () => {
    await decideApproval('r1', 'declined', null, { silent: true })
    expect(JSON.parse(sentBody())).toEqual({ status: 'declined', decision_note: null, silent: true })
  })
})
