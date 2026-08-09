// @vitest-environment jsdom
//
// COMMSFIX.B.4 — SMSBroadcastEditor passed `value=` to AudienceBuilder,
// whose prop is `filter` (AudienceBuilder has never had a `value` prop).
// Result: a saved/deep-linked audience filter was invisible — the builder
// always showed the "No filters" empty state, and one 'Add filter' click
// silently replaced the entire saved audience with the default row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

import SMSBroadcastEditor from './SMSBroadcastEditor.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const DRAFT = {
  id: 'bc-1',
  status: 'draft',
  name: 'Members blast',
  body: 'Hi {{first_name}}',
  audience_filter: {
    logic: 'and',
    filters: [{ field: 'glofox_membership_type', op: 'neq', value: 'time' }],
  },
}

describe('SMSBroadcastEditor — saved audience filter renders (B4)', () => {
  it('shows the saved filter row instead of the empty state', () => {
    const { container, queryByText } = render(
      <SMSBroadcastEditor broadcast={DRAFT} recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" />
    )
    // The saved row's field select carries the saved field…
    const fieldSelect = Array.from(container.querySelectorAll('select'))
      .find(s => s.value === 'glofox_membership_type')
    expect(fieldSelect).toBeTruthy()
    // …and the empty state is not shown.
    expect(queryByText(/No filters — all opted-in contacts/)).toBeNull()
  })

  it('renders the deep-linked preset filter when there is no saved broadcast', () => {
    const preset = { logic: 'and', filters: [{ field: 'tags', op: 'eq', value: 'PTC' }] }
    const { container } = render(
      <SMSBroadcastEditor broadcast={null} recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" initialAudienceFilter={preset} />
    )
    const fieldSelect = Array.from(container.querySelectorAll('select')).find(s => s.value === 'tags')
    expect(fieldSelect).toBeTruthy()
  })
})
