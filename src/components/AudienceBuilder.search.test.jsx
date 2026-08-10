// @vitest-environment jsdom
//
// FILTER-C.2 — substring search over the field list.
//
// FILTER-A.2 grouped the picker into nine <optgroup>s, which fixed the
// first-letter type-ahead collisions ("Membership …" ×4, "Last …" ×5) and
// explicitly left the remaining gap on the record: an operator who does not
// already know a field's exact LABEL, or which group it lives in, still has to
// open the list and scan. At 40+ fields the scan is the bottleneck.
//
// The fix keeps the native <select> — it is what supplies keyboard navigation,
// the mobile picker and correct group announcement, and a hand-rolled combobox
// would have to re-earn all of it — and puts a plain text input in front of it
// that narrows which options the select renders. Grouping survives because the
// groups are re-derived from the surviving options.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS } from './AudienceBuilder.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ONE_ROW = { logic: 'and', filters: [{ field: 'label', op: 'contains', value: 'vip' }] }

function renderOneRow(props = {}) {
  return render(<AudienceBuilder filter={ONE_ROW} onChange={() => {}} audienceCount={null} {...props} />)
}

const searchBox = () => screen.getByRole('searchbox', { name: /search fields/i })
const fieldSelect = () => screen.getByRole('combobox', { name: 'Field' })
const optionLabels = () => Array.from(fieldSelect().querySelectorAll('option'))
  .map(o => o.textContent)
  .filter(t => t !== 'Choose a field…')
const groupLabels = () => Array.from(fieldSelect().querySelectorAll('optgroup')).map(g => g.label)

describe('AudienceBuilder — the field picker is searchable', () => {
  it('offers a search control for every field picker', () => {
    renderOneRow()
    expect(searchBox()).toBeTruthy()
    // It must not be a submit-capable control inside a host <form>.
    expect(searchBox().getAttribute('type')).toBe('search')
  })

  it('renders every field until something is typed', () => {
    renderOneRow()
    expect(optionLabels()).toHaveLength(FIELD_OPTIONS.length)
  })

  it('narrows the list to substring matches on the label', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'attend' } })
    const labels = optionLabels()
    expect(labels).toContain('Last Attended')
    expect(labels).toContain('Attended (30d)')
    expect(labels).not.toContain('Gender')
    expect(labels.length).toBeLessThan(FIELD_OPTIONS.length)
  })

  it('matches case-insensitively and mid-word — the whole point of a substring search', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'CLICK' } })
    // "Emails Clicked" / "Last Email Click" are unreachable by first-letter
    // type-ahead: neither label starts with the word the operator knows.
    expect(optionLabels()).toEqual(expect.arrayContaining(['Emails Clicked', 'Last Email Click']))
  })

  it('also matches the group name, so "money" finds the money fields', () => {
    // An UNSET row, so nothing is force-included and the result set is purely
    // what the term matched.
    render(<AudienceBuilder
      filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
      onChange={() => {}}
      audienceCount={null}
    />)
    fireEvent.change(searchBox(), { target: { value: 'money' } })
    expect(groupLabels()).toEqual(['Money'])
    expect(optionLabels()).toEqual(expect.arrayContaining(['Lifetime Value (€)', 'Lifetime Payments']))
  })

  it('keeps the grouping — matches stay under their optgroup, empty groups drop out', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'attend' } })
    const groups = groupLabels()
    expect(groups).toContain('Attendance')
    expect(groups).not.toContain('Profile & data quality')
    // Every surviving option is still inside a group, never loose on the select.
    for (const opt of Array.from(fieldSelect().querySelectorAll('option'))) {
      if (opt.textContent === 'Choose a field…') continue
      expect(opt.parentElement.tagName).toBe('OPTGROUP')
    }
  })

  it('never hides the row\'s own saved field, or the select would render blank', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'zzz-no-such-field' } })
    // FILTER-A.2 lesson: a <select> whose value matches no <option> renders
    // EMPTY, which reads as an unset row while still filtering.
    expect(optionLabels()).toContain('Label')
    expect(fieldSelect().value).toBe('label')
  })

  it('says how many fields matched, in a live region', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'attend' } })
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/\d+ fields? match/i)
    fireEvent.change(searchBox(), { target: { value: 'zzz-no-such-field' } })
    expect(screen.getByRole('status').textContent).toMatch(/no fields match/i)
  })

  it('restores the full list when the search is cleared', () => {
    renderOneRow()
    fireEvent.change(searchBox(), { target: { value: 'attend' } })
    fireEvent.change(searchBox(), { target: { value: '' } })
    expect(optionLabels()).toHaveLength(FIELD_OPTIONS.length)
  })

  it('does not submit the host form when Enter is pressed in the search box', () => {
    const onSubmit = vi.fn(e => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <AudienceBuilder filter={ONE_ROW} onChange={() => {}} audienceCount={null} />
      </form>,
    )
    const evt = fireEvent.keyDown(searchBox(), { key: 'Enter', code: 'Enter' })
    // fireEvent returns false when preventDefault() was called on the event.
    expect(evt).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('is disabled with the rest of the builder', () => {
    renderOneRow({ disabled: true })
    expect(searchBox().disabled).toBe(true)
  })

  it('gives each row its own independent search', () => {
    render(<AudienceBuilder
      filter={{ logic: 'and', filters: [
        { field: 'label', op: 'contains', value: 'vip' },
        { field: 'gender', op: 'eq', value: 'male' },
      ] }}
      onChange={() => {}}
      audienceCount={null}
    />)
    const boxes = screen.getAllByRole('searchbox', { name: /search fields/i })
    expect(boxes).toHaveLength(2)
    fireEvent.change(boxes[0], { target: { value: 'attend' } })
    const selects = screen.getAllByRole('combobox', { name: 'Field' })
    expect(within(selects[1]).getByText('Gender')).toBeTruthy()
    expect(within(selects[1]).queryByText('Attended (30d)')).toBeTruthy()
    expect(within(selects[0]).queryByText('Gender')).toBeNull()
  })

  it('search is available on an UNSET row too — that is where an operator is looking', () => {
    render(<AudienceBuilder
      filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
      onChange={() => {}}
      audienceCount={null}
    />)
    fireEvent.change(searchBox(), { target: { value: 'attend' } })
    expect(optionLabels()).toContain('Attended (30d)')
    expect(optionLabels()).not.toContain('Gender')
  })
})
