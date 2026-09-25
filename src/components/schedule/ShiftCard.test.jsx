// src/components/schedule/ShiftCard.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the week card's structure: what it says, in what order, and
// what it never says. 🔴 Not its layout: whether "11:30am–12:30pm" FITS on one
// line is a browser check (memory `jsdom-cannot-see-layout`); this file can
// only pin the class that asks for it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ShiftCard from '@/components/schedule/ShiftCard'
import { shiftCardModel } from '@/lib/roster-card-model'

afterEach(() => cleanup())

const BLOCK = {
  id: 'b1', block_date: '2026-09-21', start_time: '09:15', end_time: '10:30', max_coaches: 17, min_coaches: 2,
  shift_templates: { name: 'Morning 8 Week Challenge - Strength', color: '#EC4899' },
}
const on = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'confirmed', profiles: { full_name: name }, ...over })
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

function renderCard({ assignments = [on('u2', 'Coach A'), on('u3', 'Coach B')], staffing = { status: 'ok', count: 2, min: 2 }, isManager = true, viewerId = 'u9', ...props } = {}) {
  const model = shiftCardModel(BLOCK, assignments, staffing, { isManager, viewerId })
  const onActivate = vi.fn()
  render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={onActivate} {...props} />)
  return { onActivate, card: screen.getByTestId('shift-card') }
}

describe('ShiftCard', () => {
  it('reads time, then coaches, then the template name', () => {
    renderCard()
    const time = screen.getByTestId('shift-time')
    const coaches = screen.getByTestId('shift-coaches')
    const template = screen.getByTestId('shift-template')
    expect(follows(time, coaches)).toBe(true)
    expect(follows(coaches, template)).toBe(true)
    expect(time.textContent).toBe('9:15–10:30am')
    expect(time.className).toMatch(/whitespace-nowrap/)
    // Browser-measured: at the grid floor "10:45am–12pm" crossed the card's
    // border by 5px. A time is never truncated, so the line is tightened and
    // the card's side padding is one step smaller than its vertical padding.
    expect(time.className).toMatch(/\btracking-tight\b/)
    expect(time.className).not.toMatch(/truncate|overflow-hidden/)
    expect(screen.getByTestId('shift-card').className).toMatch(/\bpx-1\.5\b/)
  })

  it('coach names are body size, one per line, and the template label is the small one', () => {
    renderCard()
    const items = screen.getByTestId('shift-coaches').querySelectorAll('li')
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['Coach A', 'Coach B'])
    for (const li of items) expect(li.className).toMatch(/\btext-sm\b/)
    expect(screen.getByTestId('shift-template').className).toMatch(/text-\[11px\]/)
  })

  it('shows the FULL template name and repeats it as a title for when it truncates', () => {
    renderCard()
    const template = screen.getByTestId('shift-template')
    expect(template.textContent).toBe('Morning 8 Week Challenge - Strength')
    expect(template.getAttribute('title')).toBe('Morning 8 Week Challenge - Strength')
  })

  // The overlay button covers the card's text, so the label's own title is
  // never under the pointer. The container's is, and it must not change what
  // the BUTTON is called (ROSTER-FIX.6b-7: the button's name stays short).
  it('the card container carries the hover tooltip; the button keeps its short name', () => {
    const { card } = renderCard()
    expect(card.getAttribute('title')).toBe('Morning 8 Week Challenge - Strength · 9:15–10:30am · Coach A, Coach B')
    const button = screen.getByRole('button')
    expect(button.getAttribute('title')).toBeNull()
    expect(button.textContent).toBe('Manage 9:15am Morning 8 Week Challenge - Strength shift, Monday 21 September')
  })

  it('is neutral: no inline colour, no template tint, the tone is data', () => {
    const { card } = renderCard()
    expect(card.getAttribute('style')).toBeNull()
    expect(card.innerHTML).not.toMatch(/#EC4899|background-color/i)
    expect(card.getAttribute('data-tone')).toBe('neutral')
    expect(card.className).toMatch(/\bbg-un1t-bg\b/)
    expect(card.className).toMatch(/\bborder-un1t-border\b/)
  })

  it('an unknown tone falls back to the neutral surface rather than none', () => {
    const model = { ...shiftCardModel(BLOCK, [], null, { isManager: true }), tone: 'not-a-tone' }
    render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={() => {}} />)
    expect(screen.getByTestId('shift-card').className).toMatch(/\bbg-un1t-bg\b/)
  })

  // 🔴 Tailwind's sr-only is position:absolute + white-space:nowrap. Inside the
  // roster's horizontal scroller an sr-only span with no positioned ancestor is
  // NOT clipped by that scroller: it widened the whole DOCUMENT to 777px on a
  // 390px phone. jsdom cannot see that (memory `jsdom-cannot-see-layout`); what
  // it can pin is that every sr-only span's parent is itself positioned.
  it('every sr-only span is anchored to a positioned parent (button, Adjusted marker, short badge)', () => {
    const { card } = renderCard({
      assignments: [on('u2', 'Coach A', { start_time_override: '09:30', partial_reason: 'late start' })],
      staffing: { status: 'short', count: 1, min: 2 },
    })
    const hidden = card.querySelectorAll('.sr-only')
    expect(hidden.length).toBe(3)
    for (const el of hidden) expect(el.parentElement.className).toMatch(/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/)
    expect(card.className).toMatch(/\brelative\b/)
  })

  it('never prints a capacity chip', () => {
    const { card } = renderCard()
    expect(card.textContent).not.toMatch(/\d+\s*\/\s*\d+/)
    expect(card.textContent).not.toMatch(/17/)
  })

  it('short: amber border and "1 of 2", said in words too', () => {
    const { card } = renderCard({ assignments: [on('u2', 'Coach A')], staffing: { status: 'short', count: 1, min: 2 } })
    expect(card.getAttribute('data-status')).toBe('short')
    expect(card.className).toMatch(/border-amber-500\/60/)
    const badge = screen.getByTestId('short-staffed-badge')
    expect(badge.textContent).toBe('Below minimum: 1 of 2')
    expect(badge.getAttribute('title')).toBe('Below minimum: 1 of 2 coaches')
  })

  it('empty: red DASHED border and "Needs coach" as real text', () => {
    const { card } = renderCard({ assignments: [], staffing: { status: 'empty', count: 0, min: 1 } })
    expect(card.getAttribute('data-status')).toBe('empty')
    expect(card.className).toMatch(/border-dashed/)
    expect(card.className).toMatch(/border-red-500\/60/)
    expect(screen.getByTestId('needs-coach-badge').textContent).toBe('Needs coach')
    expect(screen.queryByTestId('shift-coaches')).toBeNull()
  })

  it('a past empty shift is history, not an alarm', () => {
    const { card } = renderCard({ assignments: [], staffing: null })
    expect(card.getAttribute('data-status')).toBe('ok')
    expect(card.className).not.toMatch(/border-red|border-amber/)
    expect(screen.getByText('No coach (past)')).toBeTruthy()
  })

  it('keeps the Adjusted marker: a visible word, and the hours for a screen reader', () => {
    renderCard({ assignments: [on('u2', 'Coach A', { start_time_override: '09:30', partial_reason: 'late start' })] })
    const marker = screen.getByTestId('adjusted-marker')
    expect(marker.getAttribute('title')).toBe('Adjusted: 9:30am–10:30am · late start')
    expect(marker.querySelector('[aria-hidden="true"]').textContent).toBe('Adjusted')
    expect(screen.getByText(/Adjusted hours: 9:30am to 10:30am\. late start/)).toBeTruthy()
  })

  it('the click target is a real button over a plain container, named by shift and day', () => {
    const { onActivate, card } = renderCard()
    const button = screen.getByRole('button', { name: 'Manage 9:15am Morning 8 Week Challenge - Strength shift, Monday 21 September' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.parentElement).toBe(card)
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBeNull()
    fireEvent.click(button)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('select mode: the button becomes a toggle and says Select', () => {
    renderCard({ selectMode: true, isSelected: true })
    const button = screen.getByRole('button', { name: /^Select 9:15am/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('the hover hint is out of the accessibility tree, and only offered when there is something to manage', () => {
    renderCard({ showHint: true })
    expect(screen.getByText('Click to manage').getAttribute('aria-hidden')).toBe('true')
    cleanup()
    renderCard({ showHint: false })
    expect(screen.queryByText('Click to manage')).toBeNull()
  })

  // 🔴 The coach boundary, at component level.
  it('coach mode: no staffing badge, no status border, no numbers, even for a short block', () => {
    const { card } = renderCard({ isManager: false, viewerId: 'u2', assignments: [on('u2', 'Coach A')], staffing: { status: 'short', count: 1, min: 2 }, isMine: true })
    expect(screen.queryByTestId('short-staffed-badge')).toBeNull()
    expect(screen.queryByTestId('needs-coach-badge')).toBeNull()
    expect(card.getAttribute('data-status')).toBe('ok')
    expect(card.className).not.toMatch(/border-amber|border-red/)
    expect(card.textContent).not.toMatch(/\d+ of \d+|\d+\s*\/\s*\d+|17/)
    // Their own shift is still marked as theirs.
    expect(card.className).toMatch(/ring-blue-400\/50/)
    expect(screen.getByText('Coach A').className).toMatch(/text-blue-700/)
  })
})

describe('ShiftCard — admin shifts (SHIFTTYPE.1)', () => {
  it('draws the admin surface and says "Admin" in words, so the tone is never the only signal', () => {
    const model = shiftCardModel({ ...BLOCK, min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } }, [], null, { isManager: true })
    render(<ShiftCard model={model} dayLabel="Monday 21 September" onActivate={() => {}} />)
    const card = screen.getByTestId('shift-card')
    expect(card.getAttribute('data-tone')).toBe('admin')
    expect(card.className).toMatch(/\bbg-slate-500\/10\b/)
    expect(card.className).not.toMatch(/border-dashed|border-red|border-amber/)
    expect(screen.getByTestId('shift-kind').textContent).toBe('Admin')
    expect(screen.queryByTestId('needs-coach-badge')).toBeNull()
    expect(screen.getByText('Nobody assigned')).toBeTruthy()
  })

  it('a class card keeps the neutral surface and has no kind tag', () => {
    renderCard()
    expect(screen.getByTestId('shift-card').className).toMatch(/\bbg-un1t-bg\b/)
    expect(screen.queryByTestId('shift-kind')).toBeNull()
  })
})
