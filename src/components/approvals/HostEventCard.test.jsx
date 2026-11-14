// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import HostEventCard from './HostEventCard'

afterEach(cleanup)
const item = { id: 'e1', title: 'Masterclass, Pride Club', subtitle: '2026-09-20 · masterclass', meta: 'host event awaiting review', submittedAt: '2026-11-10T10:20:00Z', amount: null, reviewUrl: '/settings/hosts', venue: 'Phoenix Park', priceLabel: '€25.50' }

describe('HostEventCard', () => {
  it('shows venue and price and the Approve / Decline buttons', () => {
    render(<HostEventCard item={item} providerLabel="Host events" timezone="Europe/Dublin" />)
    expect(screen.getByText('Venue: Phoenix Park')).toBeTruthy()
    expect(screen.getByText('Price: €25.50')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open in Hosts' }).getAttribute('href')).toBe('/settings/hosts')
  })
  it('says so when there is no venue', () => {
    render(<HostEventCard item={{ ...item, venue: null, priceLabel: 'Free' }} providerLabel="Host events" />)
    expect(screen.getByText('Venue: No venue')).toBeTruthy()
    expect(screen.getByText('Price: Free')).toBeTruthy()
  })
})
