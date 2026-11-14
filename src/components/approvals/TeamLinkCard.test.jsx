// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import TeamLinkCard from './TeamLinkCard'

afterEach(cleanup)

const item = {
  id: 'r1', title: 'Week of 16 Nov', subtitle: 'Roster awaiting approval', meta: 'UN1T Stillorgan',
  submittedAt: '2026-11-10T10:20:00Z', amount: null, reviewUrl: '/schedule?week=2026-11-16',
}

describe('TeamLinkCard', () => {
  it('shows the card and one Open link, no action buttons', () => {
    render(<TeamLinkCard item={item} providerLabel="Rosters" timezone="Europe/Dublin" />)
    expect(screen.getByText('Rosters')).toBeTruthy()
    expect(screen.getByText('Week of 16 Nov')).toBeTruthy()
    expect(screen.getByText('Roster awaiting approval')).toBeTruthy()
    expect(screen.getByText('Submitted 10 Nov 2026, 10:20')).toBeTruthy()
    const open = screen.getByRole('link', { name: 'Open' })
    expect(open.getAttribute('href')).toBe('/schedule?week=2026-11-16')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('shows an amount when there is one', () => {
    render(<TeamLinkCard item={{ ...item, amount: 120, currency: 'EUR' }} providerLabel="Invoices" />)
    expect(screen.getByText('€120.00')).toBeTruthy()
  })
})
