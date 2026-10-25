// @vitest-environment jsdom
//
// ORGCONTACTS.4 (decision 3; final review I1) — the status chip filter in the
// view re-filters the rows client-side; it must judge the same column the
// server page filtered on (studio_stage_slug), or a row the server returned
// for "member at this studio" is dropped because the contact-wide stage differs.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('./AudienceBuilder', () => ({ default: () => <div data-testid="audience-builder" /> }))
vi.mock('./ContactsTable', () => ({ default: ({ contacts }) => <ul data-testid="contacts-table">{contacts.map((c) => <li key={c.id}>{c.id}</li>)}</ul> }))

import ContactsView from './ContactsView.jsx'

afterEach(cleanup)

const rows = [
  { id: 'crossover', name: 'A', pipeline_stage_slug: 'member', studio_stage_slug: 'new_lead', location_id: 'stillorgan' },
  { id: 'home', name: 'B', pipeline_stage_slug: 'new_lead', studio_stage_slug: 'new_lead', location_id: 'hatch' },
  { id: 'elsewhere', name: 'C', pipeline_stage_slug: 'new_lead', studio_stage_slug: null, location_id: 'stillorgan' },
]

describe('ContactsView status chip filters on the stage at this studio', () => {
  it('keeps the rows whose studio stage matches, whatever their contact-wide stage', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, segments: [] }) })))
    render(<ContactsView initialContacts={rows} locationId="hatch" initialStatus="new_lead" />)
    const ids = [...screen.getByTestId('contacts-table').querySelectorAll('li')].map((li) => li.textContent)
    expect(ids).toEqual(['crossover', 'home'])
    vi.unstubAllGlobals()
  })
})
