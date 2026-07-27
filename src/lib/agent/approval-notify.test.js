// APPROVALS-STUDIO.1 — one deduped push per lasting customer approval.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn(async () => ({ sent: 1 })) }))

import { notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { notifyAgentApprovalRequest } from './approval-notify'

beforeEach(() => vi.clearAllMocks())

describe('notifyAgentApprovalRequest', () => {
  it('fans out to owner/manager with a per-request dedupe key and deep-link payload', async () => {
    await notifyAgentApprovalRequest({}, {
      requestId: 'req-1', locationId: 'loc-1', kind: 'class_booking',
      customerName: 'Lucinda Kinghan', summary: 'SQUAD - CONDITIONING · Tue 07:00',
    })
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledOnce()
    const [, eventKey, locationId, roles, payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(eventKey).toBe('agent_request:req-1')
    expect(locationId).toBe('loc-1')
    expect(roles).toEqual(['owner', 'manager'])
    expect(payload.category).toBe('agent_requests')
    expect(payload.title).toContain('Class booking')
    expect(payload.body).toContain('Lucinda Kinghan')
    expect(payload.data).toEqual({ type: 'agent_request', request_id: 'req-1' })
  })

  it('no-ops without a request id (failed insert) and never throws on sender errors', async () => {
    await notifyAgentApprovalRequest({}, { requestId: null, locationId: 'loc-1', kind: 'pause' })
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    notifyUsersAtRolesOnce.mockRejectedValueOnce(new Error('expo down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(notifyAgentApprovalRequest({}, { requestId: 'r2', locationId: 'loc-1', kind: 'pause' })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
