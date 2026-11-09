// @vitest-environment jsdom
// TIERS.1 — PricingTiersEditor: rows of name / price / limit / from / until /
// min people, emitting the jsonb shape (cents, ISO instants, nulls).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import PricingTiersEditor from './PricingTiersEditor.jsx'

// The editor is controlled; a stateful host feeds each change back in so a
// second edit sees the first, as the forms do.
function Host({ initial, onChange }) {
  const [value, setValue] = useState(initial)
  return <PricingTiersEditor value={value} onChange={(v) => { setValue(v); onChange(v) }} />
}

afterEach(cleanup)

describe('PricingTiersEditor', () => {
  it('adds a tier and emits cents, a null limit and no window', () => {
    const onChange = vi.fn()
    render(<PricingTiersEditor value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add a tier/ }))
    const last = () => onChange.mock.calls.at(-1)[0]
    expect(last()).toHaveLength(1)
    expect(last()[0]).toMatchObject({ name: '', price_cents: 0, capacity: null, starts_at: null, ends_at: null, min_people: null })
    expect(last()[0].id).toMatch(/^tier-/)
  })
  it('edits a row into an early bird: price in euros becomes cents, the limit an integer', () => {
    const onChange = vi.fn()
    const value = [{ id: 'tier-1', name: '', price_cents: 0, capacity: null, starts_at: null, ends_at: null, min_people: null }]
    render(<Host initial={value} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Tier 1 name/), { target: { value: 'Early bird' } })
    fireEvent.change(screen.getByLabelText(/Tier 1 price/), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText(/Tier 1 limit/), { target: { value: '20' } })
    const last = onChange.mock.calls.at(-1)[0][0]
    expect(last).toMatchObject({ id: 'tier-1', name: 'Early bird', price_cents: 2500, capacity: 20 })
  })
  it('a window is emitted as ISO instants and a min-people as an integer; remove drops the row', () => {
    const onChange = vi.fn()
    const value = [{ id: 'tier-1', name: 'Groups', price_cents: 2800, capacity: null, starts_at: null, ends_at: null, min_people: null }]
    render(<Host initial={value} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Tier 1 until/), { target: { value: '2026-12-01T00:00' } })
    expect(onChange.mock.calls.at(-1)[0][0].ends_at).toMatch(/^2026-1[12]-\d{2}T\d{2}:\d{2}:00\.000Z$/)
    fireEvent.change(screen.getByLabelText(/Tier 1 min people/), { target: { value: '3' } })
    expect(onChange.mock.calls.at(-1)[0][0].min_people).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: /Remove tier 1/ }))
    expect(onChange.mock.calls.at(-1)[0]).toEqual([])
  })
  it('stops at eight tiers', () => {
    const value = Array.from({ length: 8 }, (_, i) => ({ id: `tier-${i}`, name: `T${i}`, price_cents: 100, capacity: null, starts_at: null, ends_at: null, min_people: null }))
    render(<PricingTiersEditor value={value} onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: /Add a tier/ })).toBeNull()
  })
})

// HOSTTHEME.1 — the host form's (dark) arm uses the theme tokens only.
describe('PricingTiersEditor dark arm (HOSTTHEME.1)', () => {
  it('renders no raw colour class and rows are wells', () => {
    const { container } = render(<PricingTiersEditor value={[{ id: 't1', name: 'Early bird', price_cents: 1500 }]} onChange={() => {}} dark />)
    const bad = []
    for (const el of container.querySelectorAll('[class]')) {
      for (const tok of String(el.getAttribute('class')).split(/\s+/).filter(Boolean)) {
        if (/^(?:[a-z-]+:)*(?:text|bg|border|divide|ring)-(?:white|black)/.test(tok) || /placeholder:text-white/.test(tok) || /^(?:[a-z-]+:)*(?:text|bg|border)-(?:red|amber|emerald|green|sky|blue|yellow)-\d/.test(tok) || /color-scheme:dark/.test(tok)) bad.push(tok)
      }
    }
    expect(bad).toEqual([])
    expect(container.querySelector('.bg-host-well')).toBeTruthy()
  })
  it('the light arm keeps the staff classes', () => {
    const { container } = render(<PricingTiersEditor value={[{ id: 't1', name: 'Early bird', price_cents: 1500 }]} onChange={() => {}} />)
    expect(container.querySelector('.bg-un1t-surface')).toBeTruthy()
    expect(container.innerHTML).not.toContain('host-')
  })
})
