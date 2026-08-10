// @vitest-environment jsdom
//
// FILTER-A.4 — accessibility and interaction (audit findings #22-33).
//
// The cluster, all in this one component: no accessible name on any control,
// a delete button announced as "button", the focus ring removed on all eight
// control instances, focus dropped on delete and never moved on add, rows
// keyed by index so deleting re-keys the rest, ALL/ANY conveyed by colour
// alone, counts and errors outside any live region, and a non-wrapping row
// that overflows horizontally at 375px.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import AudienceBuilder from './AudienceBuilder.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const THREE_ROWS = {
  logic: 'and',
  filters: [
    { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
    { field: 'total_emails_sent', op: 'gt', value: '0' },
    { field: 'label', op: 'contains', value: 'vip' },
  ],
}

// A controlled harness — the real hosts re-render with the new filter, and
// focus behaviour is only observable when they do.
function Harness({ initial = THREE_ROWS, ...props }) {
  const [filter, setFilter] = require('react').useState(initial)
  return <AudienceBuilder filter={filter} onChange={setFilter} audienceCount={null} {...props} />
}

describe('AudienceBuilder — every control has an accessible name (A4.1)', () => {
  it('names the field, condition and value controls of each row', () => {
    render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    expect(screen.getAllByRole('combobox', { name: 'Field' })).toHaveLength(3)
    expect(screen.getAllByRole('combobox', { name: 'Condition' })).toHaveLength(3)
    expect(screen.getAllByRole('combobox', { name: 'Value' })).toHaveLength(1) // the Stage row
    expect(screen.getAllByRole('textbox', { name: 'Value' })).toHaveLength(1)  // the Label row
    expect(screen.getAllByRole('spinbutton', { name: 'Value' })).toHaveLength(1) // Emails Sent
  })

  it('leaves no unnamed control anywhere in the builder', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    for (const el of container.querySelectorAll('select, input, button')) {
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
        || el.getAttribute('id') || (el.textContent || '').trim()
      expect(named, el.outerHTML.slice(0, 120)).toBeTruthy()
    }
  })

  it('gives the delete button a name that says which row it deletes', () => {
    render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    expect(screen.getByRole('button', { name: /remove filter 2/i })).toBeTruthy()
  })

  it('makes each row a labelled group, so "row 2 of 3" is announced', () => {
    render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    const groups = screen.getAllByRole('group', { name: /filter \d+ of 3/i })
    expect(groups).toHaveLength(3)
    expect(within(groups[1]).getByRole('button', { name: /remove filter 2/i })).toBeTruthy()
  })
})

describe('AudienceBuilder — the focus ring survives (A4.2)', () => {
  it('never removes the outline without putting a visible ring back', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    for (const el of container.querySelectorAll('select, input, button')) {
      const cls = el.getAttribute('class') || ''
      if (!cls.includes('focus:outline-none')) continue
      expect(cls, el.outerHTML.slice(0, 120)).toMatch(/focus-visible:ring|focus:ring/)
    }
  })
})

describe('AudienceBuilder — focus is managed (A4.3)', () => {
  it('moves focus into the row that "Add filter" just created', () => {
    render(<Harness initial={{ logic: 'and', filters: [] }} />)
    fireEvent.click(screen.getByRole('button', { name: /add filter/i }))
    const fields = screen.getAllByRole('combobox', { name: 'Field' })
    expect(document.activeElement).toBe(fields.at(-1))
  })

  it('does not strand focus on the deleted row', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /remove filter 2/i }))
    expect(document.body.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('keeps a row bound to its own identity when an earlier row is deleted', () => {
    // Rows were keyed by index, so deleting row 2 re-keyed 3 onto 2's DOM node
    // and focus landed on a control that now represented a different filter.
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /remove filter 1/i }))
    const fields = screen.getAllByRole('combobox', { name: 'Field' })
    expect(fields.map(f => f.value)).toEqual(['total_emails_sent', 'label'])
    expect(screen.getAllByRole('group', { name: /filter \d+ of 2/i })).toHaveLength(2)
  })
})

describe('AudienceBuilder — ALL/ANY is not conveyed by colour alone (A4.4)', () => {
  it('exposes the toggle as a labelled group of pressed/unpressed buttons', () => {
    render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    const group = screen.getByRole('group', { name: /how these filters combine/i })
    const all = within(group).getByRole('button', { name: /all filters/i })
    const any = within(group).getByRole('button', { name: /any filter/i })
    expect(all.getAttribute('aria-pressed')).toBe('true')
    expect(any.getAttribute('aria-pressed')).toBe('false')
  })

  it('flips aria-pressed with the selection', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /any filter/i }))
    expect(screen.getByRole('button', { name: /any filter/i }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /all filters/i }).getAttribute('aria-pressed')).toBe('false')
  })

  it('spells the connector out for assistive tech instead of leaving a bare decorative span', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    const connectors = container.querySelectorAll('[data-testid="row-connector"]')
    expect(connectors.length).toBeGreaterThan(0)
    for (const c of connectors) expect(c.getAttribute('aria-hidden')).toBe('true')
    // …because the row group's own name carries the meaning.
    expect(screen.getAllByRole('group', { name: /and .*filter 2 of 3/i }).length).toBe(1)
  })
})

describe('AudienceBuilder — the count is a live region (A4.5)', () => {
  it('announces a changing count politely', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={42} />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toBeTruthy()
    expect(live.textContent).toContain('42')
  })

  it('keeps the live region mounted when there is no count, so the first one is announced', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy()
  })
})

describe('AudienceBuilder — the row survives a narrow screen (A4.6)', () => {
  it('wraps rather than overflowing horizontally', () => {
    const { container } = render(<AudienceBuilder filter={THREE_ROWS} onChange={() => {}} audienceCount={null} />)
    for (const group of container.querySelectorAll('[role="group"][aria-label*="Filter"]')) {
      const controls = group.querySelector('div')
      expect(controls.getAttribute('class')).toContain('flex-wrap')
    }
  })
})

describe('AudienceBuilder — long filter lists stay workable (A4.7)', () => {
  const many = { logic: 'and', filters: Array.from({ length: 30 }, () => ({ field: 'label', op: 'contains', value: 'x' })) }

  it('numbers the rows visibly', () => {
    render(<AudienceBuilder filter={many} onChange={() => {}} audienceCount={null} />)
    expect(screen.getByText('30')).toBeTruthy()
  })

  it('keeps the governing ALL/ANY toggle pinned rather than scrolled away', () => {
    const { container } = render(<AudienceBuilder filter={many} onChange={() => {}} audienceCount={null} />)
    const group = container.querySelector('[data-testid="logic-toggle"]')
    expect(group.getAttribute('class')).toContain('sticky')
  })

  it('offers a clear-all that empties the rows in one action', () => {
    render(<Harness initial={many} />)
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }))
    expect(screen.queryAllByRole('group', { name: /filter \d+ of/i })).toHaveLength(0)
  })

  it('offers no clear-all when there is nothing to clear', () => {
    render(<AudienceBuilder filter={{ logic: 'and', filters: [] }} onChange={() => {}} audienceCount={null} />)
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull()
  })
})
