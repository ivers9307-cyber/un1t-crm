import { describe, it, expect } from 'vitest'
import { expenseStatusBadge } from './expense-review.js'

describe('expenseStatusBadge', () => {
  it('uses the server lifecycle', () => {
    const b = expenseStatusBadge({
      status: 'awaiting_accountant_review',
      lifecycle: { key: 'sent_to_xero', label: 'Sent to Xero', tone: 'green', detail: null },
    })
    expect(b.label).toBe('Sent to Xero')
    expect(b.icon).toBe('paper-plane-outline')
    expect(b.bg).toBe('bg-green-500/20')
  })

  it('carries the per-item breakdown', () => {
    const b = expenseStatusBadge({
      status: 'awaiting_accountant_review',
      lifecycle: { key: 'queued_for_accountant', label: 'Approved, queued for accountant', tone: 'green', detail: '1 of 2 queued for accountant, 1 of 2 paid' },
    })
    expect(b.detail).toBe('1 of 2 queued for accountant, 1 of 2 paid')
  })

  it('an approved claim without a lifecycle still gets a style (was a crash)', () => {
    const b = expenseStatusBadge({ status: 'awaiting_accountant_review' })
    expect(b.label).toBe('Approved')
    expect(b.bg).toBeTruthy()
    expect(b.text).toBeTruthy()
  })

  it.each([
    ['draft', 'Draft', 'create-outline'],
    ['submitted', 'Awaiting review', 'time-outline'],
    ['declined', 'Declined', 'close-circle-outline'],
    ['revoked', 'Revoked', 'arrow-undo-outline'],
  ])('status %s', (status, label, icon) => {
    const b = expenseStatusBadge({ status })
    expect(b.label).toBe(label)
    expect(b.icon).toBe(icon)
  })

  it('an unknown tone falls back to slate', () => {
    expect(expenseStatusBadge({ lifecycle: { key: 'x', label: 'X', tone: 'purple' } }).bg).toBe('bg-slate-500/20')
  })
})
