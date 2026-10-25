// @vitest-environment jsdom
//
// ORGCONTACTS.4 (decision 3; final review I1) — the contacts list is a
// STUDIO's list (public.studio_contacts), so its stage chip and its chip
// filter read the stage AT this studio (studio_stage_slug), never the
// contact-wide column: at Hatch 80 of 298 rows differ, and the server page
// already filters on studio_stage_slug, so a client re-filter on the
// contact-wide column dropped rows the server had returned.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('next/dynamic', () => ({ default: () => () => null }))

import ContactsTable from './ContactsTable.jsx'
import { CONTACT_LIST_FIELDS } from '@/lib/studio-contacts-query'

afterEach(cleanup)

const row = (over = {}) => ({ id: 'c1', name: 'Pat Example', location_id: 'stillorgan', email: null, phone: null, tags: [], ...over })

describe('ContactsTable stage chip reads the stage at this studio', () => {
  it('a Stillorgan member who is a new lead at Hatch shows "new lead" on Hatch\'s list', () => {
    render(<ContactsTable contacts={[row({ pipeline_stage_slug: 'member', studio_stage_slug: 'new_lead' })]} locationId="hatch" crossoverContext={{}} />)
    expect(screen.getAllByText('new lead').length).toBeGreaterThan(0)
    expect(screen.queryByText('member')).toBeNull()
  })
  it('no stage at this studio shows the empty chip, whatever the contact-wide stage says', () => {
    render(<ContactsTable contacts={[row({ pipeline_stage_slug: 'member', studio_stage_slug: null })]} locationId="hatch" crossoverContext={{}} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.queryByText('member')).toBeNull()
  })
  it('the list field set carries studio_stage_slug so the page and the search route return it', () => {
    expect(CONTACT_LIST_FIELDS.split(',').map((s) => s.trim())).toContain('studio_stage_slug')
  })
})
