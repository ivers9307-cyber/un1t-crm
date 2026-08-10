// @vitest-environment jsdom
//
// FILTER-A.3 — one tag vocabulary, and the row-3 defect that made picking a
// tag field feel broken.
//
// FILTER-FOUND row 3: switching a row to "Segment tag" or "Registered for
// event" seeded { op: 'eq', value: '' }, which the server resolvers reject —
// the operator got a 400 on the count the instant they picked the field,
// before touching anything. Same class as the blank-date bug fixed in P1.4.
// The row must stay UNSET until a value is chosen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS } from './AudienceBuilder.jsx'

const SEGMENTS = [
  { tag: 'glofox_trial_credits_low', description: 'On a trial and nearly out of credits — the moment to convert them.', count: 125 },
  { tag: 'glofox_first_booking', description: 'Made their very first booking (applied once, ever).', count: 129 },
]
const PLANS = ['3 Month Membership', '10 Class Pack']
const EVENTS = [{ id: 'ev-1', name: 'Hyrox Open', kind: 'race', race_date: '2026-09-01', registration_count: 40 }]

let fetched
function stubFetch() {
  fetched = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    fetched.push(String(url))
    const u = String(url)
    if (u.includes('/api/segments')) return { json: async () => ({ success: true, data: SEGMENTS }) }
    if (u.includes('membership-plans')) return { json: async () => ({ success: true, data: PLANS }) }
    if (u.includes('communications/events')) return { json: async () => ({ success: true, data: EVENTS }) }
    return { json: async () => ({ success: true, data: [] }) }
  }))
}

beforeEach(stubFetch)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const UNSET = { logic: 'and', filters: [{ field: '', op: '', value: '' }] }
const fieldSelect = (container) => container.querySelectorAll('select')[0]

describe('AudienceBuilder — the two tag fields are told apart, not left arbitrary (A3.1)', () => {
  it('names them by HOW they get applied, and explains each', () => {
    const auto = FIELD_OPTIONS.find(f => f.value === 'tag')
    const manual = FIELD_OPTIONS.find(f => f.value === 'tags')
    expect(auto.label).toBe('Behaviour tag')
    expect(manual.label).toBe('Manual tag')
    expect(auto.hint).toMatch(/automatic/i)
    expect(manual.hint).toMatch(/staff|import/i)
    // Adjacent in the same group so the choice is presented, not hidden.
    expect(auto.group).toBe(manual.group)
  })
})

describe('AudienceBuilder — the description /api/segments returns is shown (A3.2)', () => {
  it('renders the tag, its live count and its description', async () => {
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'glofox_first_booking' }] }}
        onChange={() => {}} audienceCount={null}
      />,
    )
    await screen.findByRole('option', { name: /glofox_first_booking/ })
    const valueSelect = container.querySelectorAll('select')[2]
    const opt = Array.from(valueSelect.querySelectorAll('option')).find(o => o.value === 'glofox_first_booking')
    expect(opt.textContent).toContain('129')
    expect(opt.getAttribute('title')).toContain('very first booking')
    // …and visibly, not only as a tooltip a keyboard user can never reach.
    expect(container.textContent).toContain('Made their very first booking')
  })

  it('asks /api/segments for the location being composed for, not the operator\'s active one', async () => {
    render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'x' }] }}
        onChange={() => {}} audienceCount={null} locationId="loc-7"
      />,
    )
    await screen.findByRole('option', { name: /glofox_first_booking/ })
    expect(fetched.find(u => u.includes('/api/segments'))).toContain('location_id=loc-7')
  })
})

describe('AudienceBuilder — FILTER-FOUND row 3: no row is born invalid (A3.3)', () => {
  it.each([
    ['tag', 'Behaviour tag'],
    ['event_registration', 'Registered for event'],
    ['glofox_membership_plan', 'Membership Plan'],
  ])('picking %s does not emit a row with an empty value', async (field) => {
    const onChange = vi.fn()
    const { container } = render(<AudienceBuilder filter={UNSET} onChange={onChange} audienceCount={null} />)
    fireEvent.change(fieldSelect(container), { target: { value: field } })
    // Either nothing was written, or what was written is still an UNSET row —
    // never a row the count endpoint will 400 on.
    for (const call of onChange.mock.calls) {
      for (const row of call[0].filters) {
        expect(row.field === '' || (row.value !== '' && row.value != null), JSON.stringify(row)).toBe(true)
      }
    }
  })

  it('still shows the chosen field and its value picker while the row waits', async () => {
    const { container } = render(<AudienceBuilder filter={UNSET} onChange={() => {}} audienceCount={null} />)
    fireEvent.change(fieldSelect(container), { target: { value: 'tag' } })
    expect(fieldSelect(container).value).toBe('tag')
    await screen.findByRole('option', { name: /glofox_first_booking/ })
    expect(container.querySelectorAll('select').length).toBeGreaterThan(1)
  })

  it('commits a complete row the moment a value is chosen', async () => {
    const onChange = vi.fn()
    const { container } = render(<AudienceBuilder filter={UNSET} onChange={onChange} audienceCount={null} />)
    fireEvent.change(fieldSelect(container), { target: { value: 'tag' } })
    await screen.findByRole('option', { name: /glofox_first_booking/ })
    const valueSelect = container.querySelectorAll('select')[1]
    fireEvent.change(valueSelect, { target: { value: 'glofox_first_booking' } })
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'and',
      filters: [{ field: 'tag', op: 'eq', value: 'glofox_first_booking' }],
    })
  })

  it('a field that needs no lookup still commits immediately (unchanged behaviour)', () => {
    const onChange = vi.fn()
    const { container } = render(<AudienceBuilder filter={UNSET} onChange={onChange} audienceCount={null} />)
    fireEvent.change(fieldSelect(container), { target: { value: 'pipeline_stage_slug' } })
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }],
    })
  })

  it('abandons the pending field if the operator picks something else', async () => {
    const onChange = vi.fn()
    const { container } = render(<AudienceBuilder filter={UNSET} onChange={onChange} audienceCount={null} />)
    fireEvent.change(fieldSelect(container), { target: { value: 'tag' } })
    fireEvent.change(fieldSelect(container), { target: { value: 'gender' } })
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'and',
      filters: [{ field: 'gender', op: 'eq', value: 'male' }],
    })
  })
})
