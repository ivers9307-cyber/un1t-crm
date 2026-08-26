// @vitest-environment jsdom
//
// FILTER-A.2 — a field picker you can navigate.
//
// 39 options in one flat native <select>, ordered by DB column. Native
// type-ahead is first-letter only, so "Membership …" has four collisions and
// "Last …" has five. The fix is grouping the way an operator thinks, labels
// that stop leaking internals (cents, vendor names, a glossary inside a
// label), and hint text on the pairs an operator genuinely cannot tell apart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS, FIELD_GROUPS } from './AudienceBuilder.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRow(row) {
  return render(
    <AudienceBuilder filter={{ logic: 'and', filters: [row] }} onChange={() => {}} audienceCount={null} />,
  )
}
const fieldSelect = (container) => container.querySelectorAll('select')[0]

describe('AudienceBuilder — fields are grouped, not a flat wall (A2.1)', () => {
  it('declares the ten operator-facing groups in order', () => {
    expect(FIELD_GROUPS).toEqual([
      'Funnel',
      'Membership & billing',
      'Attendance',
      'Money',
      'Email behaviour',
      'Tags & labels',
      'Events',
      'Studios',
      'Dates & tenure',
      'Profile & data quality',
    ])
  })

  it('assigns every field to exactly one declared group', () => {
    for (const f of FIELD_OPTIONS) {
      expect(FIELD_GROUPS, `${f.value} has group "${f.group}"`).toContain(f.group)
    }
  })

  it('renders the field picker as optgroups in the declared order, with no ungrouped option', () => {
    const { container } = renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' })
    const select = fieldSelect(container)
    const groups = Array.from(select.querySelectorAll('optgroup')).map(g => g.getAttribute('label'))
    expect(groups).toEqual(FIELD_GROUPS)
    // Only the "Choose a field…" placeholder may sit outside a group.
    const loose = Array.from(select.children).filter(el => el.tagName === 'OPTION')
    expect(loose.map(o => o.value)).toEqual([''])
  })

  it('still offers every field it offered before grouping', () => {
    const { container } = renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' })
    const values = Array.from(fieldSelect(container).querySelectorAll('option')).map(o => o.value)
    expect(new Set(values)).toEqual(new Set(['', ...FIELD_OPTIONS.map(f => f.value)]))
  })
})

describe('AudienceBuilder — money fields take euros, not cents (A2.2)', () => {
  it('labels the two cents columns in euros and never says "cents"', () => {
    for (const label of FIELD_OPTIONS.map(f => f.label)) {
      expect(label).not.toMatch(/cents/i)
    }
    const ltv = FIELD_OPTIONS.find(f => f.value === 'lifetime_value_cents')
    const price = FIELD_OPTIONS.find(f => f.value === 'glofox_membership_price_cents')
    expect(ltv.label).toContain('€')
    expect(price.label).toContain('€')
    expect(ltv.type).toBe('money')
    expect(price.type).toBe('money')
  })

  it('displays a stored cents value as euros', () => {
    const { container } = renderRow({ field: 'lifetime_value_cents', op: 'gt', value: '50000' })
    expect(container.querySelector("[data-testid=\"money-input\"]").value).toBe('500')
  })

  it('stores what the operator typed as cents — they type 120, we store 12000', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'lifetime_value_cents', op: 'gt', value: '50000' }] }}
        onChange={onChange}
        audienceCount={null}
      />,
    )
    fireEvent.change(container.querySelector("[data-testid=\"money-input\"]"), { target: { value: '120' } })
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ field: 'lifetime_value_cents', op: 'gt', value: '12000' }],
    })
  })

  it('lets a decimal amount be typed through without the display fighting back', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder
        filter={{ logic: 'and', filters: [{ field: 'lifetime_value_cents', op: 'gt', value: '0' }] }}
        onChange={onChange}
        audienceCount={null}
      />,
    )
    const input = container.querySelector("[data-testid=\"money-input\"]")
    fireEvent.change(input, { target: { value: '12.' } })
    // The draft survives on screen…
    expect(input.value).toBe('12.')
    // …and the cents written out are still correct.
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'and',
      filters: [{ field: 'lifetime_value_cents', op: 'gt', value: '1200' }],
    })
    fireEvent.change(input, { target: { value: '12.5' } })
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'and',
      filters: [{ field: 'lifetime_value_cents', op: 'gt', value: '1250' }],
    })
  })

  it('seeds a new money row with an empty value, not a stray zero', () => {
    const onChange = vi.fn()
    const { container } = render(
      <AudienceBuilder filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }} onChange={onChange} audienceCount={null} />,
    )
    fireEvent.change(fieldSelect(container), { target: { value: 'lifetime_value_cents' } })
    expect(onChange.mock.calls[0][0].filters[0].value).toBe('')
  })
})

describe('AudienceBuilder — values speak English, not Glofox (A2.3)', () => {
  it('renders membership types as plain English — "time" is monthly recurring', () => {
    const { container } = renderRow({ field: 'glofox_membership_type', op: 'neq', value: 'time' })
    const valueSelect = container.querySelectorAll('select')[2]
    const labels = Object.fromEntries(
      Array.from(valueSelect.querySelectorAll('option')).map(o => [o.value, o.textContent]),
    )
    expect(labels.time).toMatch(/monthly recurring/i)
    expect(labels.num_classes).toMatch(/class pack/i)
    expect(labels.payg).toMatch(/pay as you go/i)
  })

  it('renders funnel stages with display names, not raw slugs', () => {
    const { container } = renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' })
    const valueSelect = container.querySelectorAll('select')[2]
    const labels = Object.fromEntries(
      Array.from(valueSelect.querySelectorAll('option')).map(o => [o.value, o.textContent]),
    )
    expect(labels.pack_member).toBe('Pack member')
    expect(labels.new_lead).toBe('New lead')
    expect(labels.classpass).toBe('ClassPass')
  })

  it('drops the glossary from the Membership State label and moves it to a hint', () => {
    const state = FIELD_OPTIONS.find(f => f.value === 'glofox_membership_state')
    expect(state.label).toBe('Membership State')
    expect(state.hint).toMatch(/locked/i)
    const { container } = renderRow({ field: 'glofox_membership_state', op: 'eq', value: 'locked' })
    expect(container.textContent).toMatch(/arrears/i)
  })

  it('demotes the vendor name out of the field labels', () => {
    const vendorLabelled = FIELD_OPTIONS.filter(f => /glofox/i.test(f.label))
    expect(vendorLabelled.map(f => f.value)).toEqual([])
  })
})

describe('AudienceBuilder — near-duplicates carry a disambiguating hint (A2.4)', () => {
  it.each([
    ['pipeline_stage_slug', /classifier|funnel/i],
    ['glofox_membership_status', /stage/i],
    ['last_booked_at', /no-show|attend/i],
    ['last_attended_at', /book/i],
    ['lead_created_at', /unreliable|poisoned|do not trust/i],
    ['created_at', /crm/i],
    ['joined_at', /tenure|membership/i],
    ['last_payment_at', /invoice/i],
    ['last_invoice_at', /stale/i],
  ])('%s explains itself', (field, pattern) => {
    const cfg = FIELD_OPTIONS.find(f => f.value === field)
    expect(cfg.hint, field).toMatch(pattern)
  })

  it('renders the hint under the row and points the field control at it', () => {
    const { container } = renderRow({ field: 'lead_created_at', op: 'gt', value: '2026-01-01' })
    const select = fieldSelect(container)
    const describedBy = select.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const hint = container.querySelector(`#${describedBy}`)
    expect(hint.textContent).toMatch(/lead_created_at|unreliable|poisoned/i)
  })

  it('renders no hint element for a field that needs none', () => {
    const { container } = renderRow({ field: 'gender', op: 'eq', value: 'male' })
    expect(fieldSelect(container).getAttribute('aria-describedby')).toBeNull()
  })
})

describe('AudienceBuilder — a saved value that no longer exists is visible (A2.5)', () => {
  it('keeps the retired stage value selectable and flags it', () => {
    // Three live campaigns still carry the retired `active_member` stage.
    const { container } = renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' })
    const valueSelect = container.querySelectorAll('select')[2]
    expect(valueSelect.value).toBe('active_member')
    expect(screen.getByText(/no longer exists as a value/i)).toBeTruthy()
  })

  it('says nothing about a value that is still current', () => {
    renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' })
    expect(screen.queryByText(/no longer exists as a value/i)).toBeNull()
  })
})
