// @vitest-environment jsdom
//
// WRCPACK.1 — the WRC inspection pack card on the Reporting tab: offered to
// the owner tier only (the same rule the route enforces), and its two links
// carry the organisation, the period and the file to the CSV route.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'

import ScheduleReporting, { WrcPackCard } from '@/components/ScheduleReporting'

afterEach(cleanup)

const ORG = 'f1000000-0000-0000-0000-000000000001'
const LOC_A = 'a0000000-0000-0000-0000-000000000001'

function user(role) {
  return {
    id: 'u1', role, profileRole: role, isMaster: role === 'master',
    locations: [{ id: LOC_A, name: 'Stillorgan', organization_id: ORG }],
    rolesByLocation: { [LOC_A]: role === 'master' ? 'owner' : role },
    orgAdminOrgIds: [],
    activeLocation: { id: LOC_A, name: 'Stillorgan', organization_id: ORG },
    activeOrganization: { id: ORG, name: 'UN1T Group' },
  }
}

beforeEach(() => {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) }))
})

describe('ScheduleReporting — WRC inspection pack', () => {
  it('an owner sees the card with both CSV links to the route', async () => {
    await act(async () => { render(<ScheduleReporting user={user('owner')} />) })
    expect(screen.getByText('WRC inspection pack')).toBeTruthy()
    const staff = screen.getByText('Staff summary (CSV)').closest('a')
    const shifts = screen.getByText('Timesheets (CSV)').closest('a')
    expect(staff.getAttribute('href')).toMatch(/^\/api\/schedule\/reports\/wrc-pack\?format=csv&file=staff&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&organization_id=/)
    expect(staff.getAttribute('href')).toContain(`organization_id=${ORG}`)
    expect(shifts.getAttribute('href')).toContain('file=shifts')
    expect(staff.hasAttribute('download')).toBe(true)
  })

  it('a manager and a head coach do not see it', async () => {
    for (const role of ['manager', 'head_coach']) {
      await act(async () => { render(<ScheduleReporting user={user(role)} />) })
      expect(screen.queryByText('WRC inspection pack'), role).toBeNull()
      cleanup()
    }
  })

  it('editing the period changes both links', () => {
    render(<WrcPackCard organizationId={ORG} />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } })
    for (const label of ['Staff summary (CSV)', 'Timesheets (CSV)']) {
      const href = screen.getByText(label).closest('a').getAttribute('href')
      expect(href).toContain('from=2026-01-01')
      expect(href).toContain('to=2026-06-30')
    }
  })
})
