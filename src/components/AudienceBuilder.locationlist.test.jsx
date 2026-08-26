// @vitest-environment jsdom
//
// LISTFILTER.1 — the "On another studio's list" row.
//
// The control it renders matters more than it looks: DynamicValueSelect used
// to END in the events <select>, so every dynamic type was that dropdown
// unless something claimed it first. A studio row rendering a control
// labelled "Event", populated from /api/communications/events, would look
// plausible and build the wrong audience.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import AudienceBuilder, { FIELD_OPTIONS } from './AudienceBuilder.jsx'

const LOCATIONS = [
  { id: 'hatch-id', name: 'UN1T Hatch Street' },
  { id: 'still-id', name: 'UN1T Stillorgan' },
]

let fetched
beforeEach(() => {
  fetched = []
  vi.stubGlobal('fetch', vi.fn((url) => {
    fetched.push(url)
    if (String(url).startsWith('/api/locations')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: LOCATIONS }) })
    }
    return new Promise(() => {}) // every other loader hangs, as in the sibling tests
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderRow(row, onChange = () => {}) {
  return render(
    <AudienceBuilder filter={{ logic: 'and', filters: [row] }} onChange={onChange} audienceCount={null} />,
  )
}

describe("AudienceBuilder — On another studio's list", () => {
  it('offers the field, in the Studios group', () => {
    const cfg = FIELD_OPTIONS.find(f => f.value === 'location_list')
    expect(cfg).toBeTruthy()
    expect(cfg.group).toBe('Studios')
    expect(cfg.type).toBe('location-select')
  })

  it('renders a STUDIO picker, not the events dropdown it used to fall through to', async () => {
    renderRow({ field: 'location_list', op: 'eq', value: '' })
    const select = await screen.findByLabelText('Studio')
    expect(select).toBeTruthy()
    expect(screen.queryByLabelText('Event')).toBeNull()
  })

  it('loads its options from /api/locations and never from the events route', async () => {
    renderRow({ field: 'location_list', op: 'eq', value: '' })
    await waitFor(() => expect(screen.getByLabelText('Studio').querySelectorAll('option').length).toBe(3))
    const opts = Array.from(screen.getByLabelText('Studio').querySelectorAll('option')).map(o => o.textContent)
    expect(opts).toEqual(['— pick a studio —', 'UN1T Hatch Street', 'UN1T Stillorgan'])
    expect(fetched.some(u => String(u).startsWith('/api/locations'))).toBe(true)
    expect(fetched.some(u => String(u).includes('/events'))).toBe(false)
  })

  it('offers on / not on, and nothing else', async () => {
    const { container } = renderRow({ field: 'location_list', op: 'eq', value: 'hatch-id' })
    const opSelect = container.querySelectorAll('select')[1]
    const labels = Array.from(opSelect.querySelectorAll('option')).map(o => o.textContent)
    expect(labels).toEqual(['on the list for', 'not on the list for'])
  })

  it('emits the location id as the row value', async () => {
    const onChange = vi.fn()
    renderRow({ field: 'location_list', op: 'eq', value: '' }, onChange)
    const select = await screen.findByLabelText('Studio')
    await waitFor(() => expect(select.querySelectorAll('option').length).toBe(3))
    fireEvent.change(select, { target: { value: 'hatch-id' } })
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)[0]
    expect(last.filters[0]).toMatchObject({ field: 'location_list', op: 'eq', value: 'hatch-id' })
  })

  it('does not fetch studios until such a row exists', () => {
    renderRow({ field: 'pipeline_stage_slug', op: 'eq', value: 'member' })
    expect(fetched.some(u => String(u).startsWith('/api/locations'))).toBe(false)
  })
})
