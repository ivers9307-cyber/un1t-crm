// @vitest-environment jsdom
// HOSTSTATS.1 — the Signups card: the four figures, the source list and the
// waitlist line, with the unavailable copy when the stats could not be read.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import EventSignupsCard from './EventSignupsCard.jsx'

afterEach(cleanup)

const STATS = {
  views: 48, unique_visitors: 40, registrations: 6, confirmed: 5, conversion_pct: 12.5,
  by_source: [
    { source: 'host_email', label: 'Host email', views: 30, registrations: 4 },
    { source: 'instagram', label: 'Instagram', views: 10, registrations: 1 },
  ],
  waitlist: { waiting: 3, offered: 1, claimed: 2 },
  capped: false,
}

describe('EventSignupsCard', () => {
  it('shows the four figures and the sources', () => {
    render(<EventSignupsCard stats={STATS} />)
    expect(screen.getByText('Signups')).toBeTruthy()
    expect(screen.getByText('48')).toBeTruthy()
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('12.5%')).toBeTruthy()
    expect(screen.getByText('Host email')).toBeTruthy()
    expect(screen.getByText('Instagram')).toBeTruthy()
    expect(screen.getByText(/3 waiting/)).toBeTruthy()
    expect(screen.getByText(/1 offered/)).toBeTruthy()
    expect(screen.getByText(/2 booked from the list/)).toBeTruthy()
  })
  it('a null conversion is a dash; an empty waitlist and no sources show no lines', () => {
    render(<EventSignupsCard stats={{ ...STATS, conversion_pct: null, by_source: [], waitlist: { waiting: 0, offered: 0, claimed: 0 } }} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText(/waiting/)).toBeNull()
    expect(screen.queryByText('Where they came from')).toBeNull()
  })
  it('a zero conversion reads 0%', () => {
    render(<EventSignupsCard stats={{ ...STATS, conversion_pct: 0 }} />)
    expect(screen.getByText('0%')).toBeTruthy()
  })
  it('null stats → the unavailable copy', () => {
    render(<EventSignupsCard stats={null} />)
    expect(screen.getByText('Signup stats unavailable right now.')).toBeTruthy()
  })
})
