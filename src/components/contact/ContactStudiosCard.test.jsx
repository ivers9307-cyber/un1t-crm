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

// ORGCONTACTS.4 (decision 4) — "Change primary studio": only for a caller the
// delete / rehome gate admits, and only when there is another studio to move to.
describe('ContactStudiosCard — change primary studio', () => {
  it('renders the control with the other studios as options when canRehome; not otherwise; not with one studio', () => {
    const { container } = render(<ContactStudiosCard studios={rows} primaryLocationId="still" canRehome contactId="c-1" />)
    const select = container.querySelector('select[name="primary_location_id"]')
    expect(select).not.toBeNull()
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['hatch'])
    expect(container.textContent).toMatch(/Change primary studio/)

    const { container: noGate } = render(<ContactStudiosCard studios={rows} primaryLocationId="still" contactId="c-1" />)
    expect(noGate.querySelector('select[name="primary_location_id"]')).toBeNull()

    const { container: one } = render(<ContactStudiosCard studios={[rows[1]]} primaryLocationId="still" canRehome contactId="c-1" />)
    expect(one.querySelector('select[name="primary_location_id"]')).toBeNull()
  })

  // Review Focus 1 (final review I3): a deactivated studio or a host anchor is
  // never offered as a primary studio, whatever relationship the person holds there.
  it('offers neither a deactivated studio nor a host anchor; with none left the control is not rendered', () => {
    const closed = { ...rows[0], location_id: 'closed', location: { id: 'closed', name: 'UN1T Closed', active: false } }
    const anchor = { ...rows[0], location_id: 'anchor', location: { id: 'anchor', name: 'Host anchor', is_host_anchor: true } }
    const { container } = render(<ContactStudiosCard studios={[...rows, closed, anchor]} primaryLocationId="still" canRehome contactId="c-1" />)
    const select = container.querySelector('select[name="primary_location_id"]')
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['hatch'])
    expect(container.textContent).toContain('UN1T Closed') // the card still lists the relationship

    const { container: none } = render(<ContactStudiosCard studios={[rows[1], closed, anchor]} primaryLocationId="still" canRehome contactId="c-1" />)
    expect(none.querySelector('select[name="primary_location_id"]')).toBeNull()
  })
})
