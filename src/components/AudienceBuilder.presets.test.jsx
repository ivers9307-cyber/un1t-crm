// @vitest-environment jsdom
//
// FILTER-A.1 — preset chips on the builder.
//
// A preset is a shortcut, never a black box: clicking one must leave the
// operator looking at the same editable rows they would have built by hand,
// with nothing hidden and no number promised that the send has to honour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS } from './AudienceBuilder.jsx'
import { AUDIENCE_PRESETS } from '@/lib/audience-presets'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const EMPTY = { logic: 'and', filters: [] }

describe('AudienceBuilder — preset chips are opt-in per host (A1.1)', () => {
  it('renders no presets by default (sequences and /contacts must not get them)', () => {
    render(<AudienceBuilder filter={EMPTY} onChange={() => {}} audienceCount={null} />)
    expect(screen.queryByRole('group', { name: /preset audiences/i })).toBeNull()
  })

  it('renders a chip per preset when the host opts in', () => {
    render(<AudienceBuilder filter={EMPTY} onChange={() => {}} audienceCount={null} presets={AUDIENCE_PRESETS} />)
    const group = screen.getByRole('group', { name: /preset audiences/i })
    expect(group).toBeTruthy()
    for (const p of AUDIENCE_PRESETS) {
      expect(screen.getByRole('button', { name: p.label }), p.id).toBeTruthy()
    }
  })
})

describe('AudienceBuilder — clicking a preset writes real, editable rows (A1.2)', () => {
  it('replaces the filter with the preset rows under AND logic', () => {
    const onChange = vi.fn()
    render(<AudienceBuilder filter={EMPTY} onChange={onChange} audienceCount={null} presets={AUDIENCE_PRESETS} />)
    fireEvent.click(screen.getByRole('button', { name: /Everyone except monthly members/i }))
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [{ field: 'glofox_membership_type', op: 'neq', value: 'time' }],
    })
  })

  it('writes a two-row conjunction for the multi-row preset', () => {
    const onChange = vi.fn()
    render(<AudienceBuilder filter={EMPTY} onChange={onChange} audienceCount={null} presets={AUDIENCE_PRESETS} />)
    fireEvent.click(screen.getByRole('button', { name: /Sent but never opened/i }))
    expect(onChange).toHaveBeenCalledWith({
      logic: 'and',
      filters: [
        { field: 'total_emails_sent', op: 'gt', value: '0' },
        { field: 'total_emails_opened', op: 'eq', value: '0' },
      ],
    })
  })

  it('clears the rows for the no-conditions preset rather than leaving stale ones', () => {
    const onChange = vi.fn()
    render(
      <AudienceBuilder
        filter={{ logic: 'or', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }}
        onChange={onChange}
        audienceCount={null}
        presets={AUDIENCE_PRESETS}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Everyone we can email/i }))
    expect(onChange).toHaveBeenCalledWith({ logic: 'and', filters: [] })
  })

  it('the rows a preset writes are the rows the builder itself can render and edit', () => {
    // Every preset field must exist in FIELD_OPTIONS, or a click would produce
    // rows the builder renders as inert "unsupported field" warnings.
    const known = new Set(FIELD_OPTIONS.map(f => f.value))
    for (const preset of AUDIENCE_PRESETS) {
      for (const row of preset.filters) {
        expect(known, `${preset.id}: ${row.field} missing from FIELD_OPTIONS`).toContain(row.field)
      }
    }
  })

  it('does not fire onChange when the builder is disabled', () => {
    const onChange = vi.fn()
    render(<AudienceBuilder filter={EMPTY} onChange={onChange} audienceCount={null} presets={AUDIENCE_PRESETS} disabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AudienceBuilder — a chip promises no number (A1.3)', () => {
  it('renders no count on any chip', () => {
    const { container } = render(
      <AudienceBuilder filter={EMPTY} onChange={() => {}} audienceCount={null} presets={AUDIENCE_PRESETS} />,
    )
    const group = container.querySelector('[data-testid="audience-presets"]')
    expect(group.textContent).not.toMatch(/\d{3,}/)
  })

  it('describes each preset in the chip title rather than in a number', () => {
    render(<AudienceBuilder filter={EMPTY} onChange={() => {}} audienceCount={null} presets={AUDIENCE_PRESETS} />)
    const chip = screen.getByRole('button', { name: /In arrears/i })
    expect(chip.getAttribute('title')).toMatch(/arrears/i)
  })
})
