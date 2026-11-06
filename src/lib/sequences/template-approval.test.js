import { describe, it, expect } from 'vitest'
import { whatsappApprovalIssues } from './template-approval'

const refs = [{ stepNumber: 2, nodeId: 'n2', templateId: 't1' }]

describe('whatsappApprovalIssues', () => {
  it('flagsPendingTemplate', () => {
    const out = whatsappApprovalIssues(refs, [{ id: 't1', name: 'Trial follow-up', status: 'PENDING' }])
    expect(out).toHaveLength(1)
    expect(out[0].code).toBe('template_not_approved')
    expect(out[0].nodeId).toBe('n2')
    expect(out[0].message).toContain('Trial follow-up')
    expect(out[0].message).toContain('PENDING')
  })
  it('flagsMissingTemplate', () => {
    const out = whatsappApprovalIssues(refs, [{ id: 'other', name: 'x', status: 'APPROVED' }])
    expect(out).toHaveLength(1)
    expect(out[0].code).toBe('template_not_found')
  })
  it('passesApproved', () => {
    expect(whatsappApprovalIssues(refs, [{ id: 't1', name: 'x', status: 'APPROVED' }])).toEqual([])
  })
})
