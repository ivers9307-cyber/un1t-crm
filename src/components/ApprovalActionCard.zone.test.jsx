// @vitest-environment jsdom
// APPROVALSQ.3 — the decided line on the inbox card renders on the studio's clock.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/components/SequencePicker', () => ({ default: () => null }))
const { default: ApprovalActionCard } = await import('./ApprovalActionCard.jsx')

const req = (decided_at) => ({
  id: 'a0000000-0000-4000-8000-000000000001', kind: 'pause', status: 'declined',
  details: { cleared: { silent: true } }, decision_note: null, decided_by_name: 'Sarah', decided_at,
})
afterEach(cleanup)

describe('ApprovalActionCard studio clock', () => {
  it('shows the New York wall time for a New York studio', () => {
    const { container } = render(<ApprovalActionCard request={req('2026-11-14T16:20:00Z')} timezone="America/New_York" />)
    expect(container.textContent).toContain('by Sarah, 14 Nov 2026, 11:20')
  })
  it('falls back to the platform zone with no prop', () => {
    const { container } = render(<ApprovalActionCard request={req('2026-11-14T16:20:00Z')} />)
    expect(container.textContent).toContain('by Sarah, 14 Nov 2026, 16:20')
  })
  it('crosses DST in both zones', () => {
    const ny = render(<ApprovalActionCard request={req('2026-07-14T16:20:00Z')} timezone="America/New_York" />)
    expect(ny.container.textContent).toContain('14 Jul 2026, 12:20')
    ny.unmount()
    const dub = render(<ApprovalActionCard request={req('2026-07-14T16:20:00Z')} />)
    expect(dub.container.textContent).toContain('14 Jul 2026, 17:20')
  })
})
