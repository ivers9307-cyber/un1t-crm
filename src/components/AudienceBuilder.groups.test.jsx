// @vitest-environment jsdom
// SEGGROUPS.2 — groups in the audience builder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import AudienceBuilder from './AudienceBuilder.jsx'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AudienceBuilder groups (SEGGROUPS.2)', () => {
  it('"Add group" appends a group with two empty rows matching any', () => {
    const onChange = vi.fn()
    render(<AudienceBuilder filter={{ logic: 'and', filters: [] }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }))
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ group: { logic: 'or', filters: [{ field: '', op: '', value: '' }, { field: '', op: '', value: '' }] } }],
    })
  })

  it('renders a group, hides tag-type fields in it, and offers no nested group', () => {
    const filter = { logic: 'and', filters: [{ group: { logic: 'or', filters: [{ field: '', op: '', value: '' }] } }] }
    const { container } = render(<AudienceBuilder filter={filter} onChange={() => {}} />)
    expect(screen.getByText(/Group: match any of these/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Add group' })).toHaveLength(1)
    const groupBox = container.querySelector('[aria-label$="(group)"]')
    const values = Array.from(groupBox.querySelectorAll('select option')).map((o) => o.value)
    expect(values).not.toContain('tag')
    expect(values).not.toContain('campaign_clicked')
    expect(values).toContain('last_attended_at')
  })

  it('editing a row inside a group updates only that group', () => {
    const onChange = vi.fn()
    const filter = { logic: 'and', filters: [
      { field: 'email_status', op: 'eq', value: 'active' },
      { group: { logic: 'or', filters: [{ field: '', op: '', value: '' }] } },
    ] }
    const { container } = render(<AudienceBuilder filter={filter} onChange={onChange} />)
    const groupBox = container.querySelector('[aria-label$="(group)"]')
    const fieldSelect = groupBox.querySelector('select')
    fireEvent.change(fieldSelect, { target: { value: 'last_attended_at' } })
    const last = onChange.mock.calls.at(-1)[0]
    expect(last.filters[0]).toEqual({ field: 'email_status', op: 'eq', value: 'active' })
    expect(last.filters[1].group.filters[0].field).toBe('last_attended_at')
    expect(last.filters[1].group.logic).toBe('or')
  })
})
