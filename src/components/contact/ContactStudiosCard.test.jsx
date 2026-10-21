// @vitest-environment jsdom
//
// ORGCONTACTS.2 — the contact page's Studios card: every studio the person
// has a relationship with (contact_studios, mig 764), the primary studio
// first, each with its kind, status and first / last seen.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ContactStudiosCard from './ContactStudiosCard.jsx'

afterEach(cleanup)

const rows = [
  { location_id: 'hatch', kind: 'client', status: 'ended', source: 'un1t_online', first_seen_at: '2026-02-01T00:00:00Z', last_seen_at: null, location: { id: 'hatch', name: 'UN1T Hatch Street' } },
  { location_id: 'still', kind: 'member', status: 'active', source: 'glofox', first_seen_at: '2026-01-05T00:00:00Z', last_seen_at: '2026-10-12T00:00:00Z', location: { id: 'still', name: 'UN1T Stillorgan' } },
]

describe('ContactStudiosCard', () => {
  it('renders nothing with no rows', () => {
    const { container } = render(<ContactStudiosCard studios={[]} primaryLocationId="still" />)
    expect(container.innerHTML).toBe('')
  })
  it('lists each studio, the primary first, with kind, status, source and seen dates', () => {
    const { container } = render(<ContactStudiosCard studios={rows} primaryLocationId="still" />)
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent)
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('UN1T Stillorgan')
    expect(items[0]).toContain('Primary')
    expect(items[0]).toContain('Member')
    expect(items[0]).toContain('Active')
    expect(items[0]).toContain('Glofox')
    expect(items[0]).toContain('last seen 12 Oct 2026')
    expect(items[1]).toContain('UN1T Hatch Street')
    expect(items[1]).toContain('Client')
    expect(items[1]).toContain('Ended')
    expect(items[1]).toContain('un1t.online')
    expect(items[1]).not.toContain('Primary')
  })
  it('a studio the read could not name shows as Studio', () => {
    const { container } = render(<ContactStudiosCard studios={[{ ...rows[0], location: null }]} primaryLocationId="still" />)
    expect(container.textContent).toContain('Studio')
  })
})
