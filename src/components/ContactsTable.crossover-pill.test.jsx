// @vitest-environment jsdom
//
// ORGCONTACTS.0 — the crossover pill names the contact's PRIMARY studio and
// gives no reason. Its old tooltip said "shown here because they have a deal
// at this studio", which has been wrong since mig 731 (an active membership),
// 732 (a un1t.online client) and 758 (a Glofox crossover member) also put a
// contact owned elsewhere on this studio's list.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('next/dynamic', () => ({ default: () => () => null }))

import ContactsTable from './ContactsTable.jsx'

afterEach(cleanup)

describe('ContactsTable crossover pill', () => {
  it('names the primary studio and no reason', () => {
    render(
      <ContactsTable
        contacts={[{ id: 'c1', name: 'Pat Example', location_id: 'stillorgan', email: null, phone: null, pipeline_stage_slug: null, tags: [] }]}
        locationId="hatch"
        crossoverContext={{ c1: { homeStudio: 'UN1T Stillorgan', tags: [] } }}
      />
    )
    const pill = screen.getAllByText('UN1T Stillorgan')[0]
    expect(pill.getAttribute('title')).toBe('Primary studio: UN1T Stillorgan. Shown here because they have a relationship with this studio.')
  })
})
