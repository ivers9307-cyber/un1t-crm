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

// DTLOCAL.1 — the editor carried private copies of isoToLocalDatetime /
// localDatetimeToIso, duplicating the extracted, TZ-tested pair in
// src/lib/datetime-local.js. They agreed on every value the pickers actually
// produce; they disagreed on unparseable input, where the copies rendered
// "NaN-NaN-NaNTNaN:NaN" and threw a RangeError respectively. These pin the
// behaviour that has to survive the swap.
describe('SMSBroadcastEditor — scheduling uses the shared datetime helpers', () => {
  const scheduleInput = (container) => container.querySelector('input[type="datetime-local"]')

  it('seeds the picker with the LOCAL wall clock of the saved instant, not the UTC slice', async () => {
    const { isoToLocalDatetime } = await import('@/lib/datetime-local.js')
    const iso = '2026-08-20T09:00:00.000Z'
    const { container } = render(
      <SMSBroadcastEditor broadcast={{ ...DRAFT, scheduled_at: iso }} recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" />
    )
    const input = scheduleInput(container)
    expect(input.value).toBe(isoToLocalDatetime(iso))
    if (new Date(iso).getTimezoneOffset() !== 0) {
      expect(input.value).not.toBe(iso.slice(0, 16))
    }
  })

  it('renders a usable min attribute rather than a NaN string', () => {
    const { container } = render(
      <SMSBroadcastEditor broadcast={DRAFT} recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" />
    )
    const min = scheduleInput(container).getAttribute('min')
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(min).not.toContain('NaN')
  })

  it('leaves the picker empty for an unsaved schedule instead of writing NaN into it', () => {
    const { container } = render(
      <SMSBroadcastEditor broadcast={{ ...DRAFT, scheduled_at: null }} recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" />
    )
    expect(scheduleInput(container).value).toBe('')
  })
})

// COMMS-DETAIL-FIX.5 — the recipients list rendered `r.contact_id.slice(0,8)…`
// because the dispatcher's SMS query joined no contacts. Email and WhatsApp
// both show a person. A truncated UUID identifies nobody: an operator looking
// at a failed send cannot tell who to ring.
//
// COMMS-DETAIL-FIX.4 — SMS also passed no status slot, so a sent, a cancelled
// and a scheduled broadcast rendered an identical header.
const SENT = {
  id: 'bc-9', status: 'sent', name: 'Class moved', body: 'Saturday 09:00 is now 09:30',
  total_recipients: 3, total_sent: 3, total_delivered: 2, total_undelivered: 0, total_failed: 1,
}

describe('SMSBroadcastEditor — recipients are people, not UUID stubs (FIX.5)', () => {
  const RECIPIENTS = [
    { id: 'r1', contact_id: 'aaaa1111-1111-2222-3333-444455556666', status: 'delivered', contacts: { name: 'Aoife Byrne', phone: '+353871234567' } },
    { id: 'r2', contact_id: 'bbbb2222-aaaa-bbbb-cccc-ddddeeeeffff', status: 'failed', contacts: { name: null, phone: '+353879999999' } },
    // The contact row is genuinely gone (redacted/deleted) — an id is the
    // only honest answer left, and the ONLY case that may show one.
    { id: 'r3', contact_id: '6f1c2a44-9999-8888-7777-666655554444', status: 'sent', contacts: null },
  ]

  function renderResults() {
    return render(<SMSBroadcastEditor broadcast={SENT} recipients={RECIPIENTS} locationId="loc-1" locationSenderId="UN1T" userId="u1" />)
  }

  it('shows the contact name when there is one', () => {
    const { getByText } = renderResults()
    expect(getByText('Aoife Byrne')).toBeTruthy()
  })

  it('falls back to the phone number when the contact has no name', () => {
    const { getByText } = renderResults()
    expect(getByText('+353879999999')).toBeTruthy()
  })

  it('only falls back to an id when there is nothing else at all', () => {
    const { getByText } = renderResults()
    expect(getByText(/6f1c2a44/)).toBeTruthy()
  })

  it('never prints a uuid for a contact it could name or number', () => {
    const { container } = renderResults()
    expect(container.textContent).not.toContain('aaaa1111')
    expect(container.textContent).not.toContain('bbbb2222')
  })
})

describe('SMSBroadcastEditor — the header shows its status (FIX.4)', () => {
  it('renders a status pill for a sent broadcast', () => {
    const { getByTestId } = render(<SMSBroadcastEditor broadcast={SENT} recipients={[]} locationId="loc-1" locationSenderId="UN1T" userId="u1" />)
    expect(getByTestId('send-status-pill').textContent).toBe('Sent')
  })

  it('does not render "Sent" for a cancelled broadcast', () => {
    const { getByTestId } = render(<SMSBroadcastEditor broadcast={{ ...SENT, status: 'cancelled' }} recipients={[]} locationId="loc-1" locationSenderId="UN1T" userId="u1" />)
    expect(getByTestId('send-status-pill').textContent).toBe('Cancelled')
  })

  it('omits the pill entirely for an unsaved new broadcast', () => {
    const { queryByTestId } = render(<SMSBroadcastEditor broadcast={null} recipients={[]} locationId="loc-1" locationSenderId="UN1T" userId="u1" />)
    expect(queryByTestId('send-status-pill')).toBeNull()
  })
})
