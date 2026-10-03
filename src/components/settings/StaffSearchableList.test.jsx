// @vitest-environment jsdom
//
// C141 ORGROLE.2 — the Device column and its "Needs update" filter are the
// staff device fleet (organisation admins only since C18). Without
// showDevices neither renders.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))

import StaffSearchableList from './StaffSearchableList'

const STAFF = [{ id: 's1', full_name: 'Sam', email: 'sam@example.test', role: 'staff', active: true, profile_locations: [] }]

afterEach(cleanup)

describe('StaffSearchableList — Device column (C141)', () => {
  it('hides the Device column and the Needs update filter without showDevices', () => {
    render(<StaffSearchableList staff={STAFF} canEditFns={{}} />)
    expect(screen.queryByText('Device')).toBeNull()
    expect(screen.queryByText('Needs update')).toBeNull()
    expect(screen.queryByText('No app')).toBeNull()
  })

  it('shows them for an organisation admin (showDevices)', () => {
    render(
      <StaffSearchableList
        staff={STAFF}
        canEditFns={{}}
        showDevices
        verdictsById={{ s1: { kind: 'no_device' } }}
      />,
    )
    expect(screen.getByText('Device')).toBeTruthy()
    expect(screen.getByText('Needs update')).toBeTruthy()
  })
})
