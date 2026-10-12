// @vitest-environment jsdom
// HATCH-MEMBERS.1 — the contact page shows a membership held outside Glofox.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import StudioMembershipsCard from './StudioMembershipsCard.jsx'

afterEach(cleanup)

describe('StudioMembershipsCard', () => {
  it('renders nothing without memberships', () => {
    const { container } = render(<StudioMembershipsCard memberships={[]} />)
    expect(container.textContent).toBe('')
  })

  it('shows plan, studio, source and state', () => {
    const { container } = render(<StudioMembershipsCard memberships={[
      { id: 'm1', plan_name: 'Founding Membership — Unlimited', status: 'active', source: 'un1t_online_export', last_seen_at: '2026-10-12T12:00:00Z', locations: { name: 'UN1T Hatch Street' } },
      { id: 'm2', plan_name: 'Old plan', status: 'ended', source: 'un1t_online_export', last_seen_at: '2026-09-01T12:00:00Z', ended_at: '2026-10-12T12:00:00Z', locations: { name: 'UN1T Hatch Street' } },
    ]} />)
    const text = container.textContent
    expect(text).toContain('Founding Membership — Unlimited')
    expect(text).toContain('Active')
    expect(text).toContain('UN1T Hatch Street · from the un1t.online export of 12 Oct 2026')
    expect(text).toContain('Ended')
    expect(text).toContain('ended 12 Oct 2026')
  })
})
