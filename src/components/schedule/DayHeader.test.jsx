// src/components/schedule/DayHeader.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the Studio Overview strip folded into the week's day headers.
// Roles, names and presence only; nothing here says the pill FITS the header
// (memory `jsdom-cannot-see-layout`).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import DayHeader from '@/components/schedule/DayHeader'

afterEach(() => cleanup())

const OK = { tone: 'ok', label: '', labelWide: '', srLabel: 'Shifts at minimum', title: 'Every shift has its minimum number of coaches' }
const SHORT = { tone: 'short', label: '1 short', labelWide: '1 short', srLabel: '1 shift needs coaches: 1 below the minimum', title: '1 shift needs coaches: 1 below the minimum' }
const EMPTY = { tone: 'empty', label: '1 no coach', labelWide: '1 no coach · 1 short', srLabel: '2 shifts need coaches: 1 with no coach, 1 below the minimum', title: '2 shifts need coaches: 1 with no coach, 1 below the minimum' }
const NONE = { tone: 'none', label: '', srLabel: '', title: '' }
const base = { label: 'Mon', dayNumber: 21, fullDate: 'Monday 21 September', isToday: false, holiday: null }

describe('DayHeader', () => {
  it('manager: the header is a button named by its date, its status and what it opens', () => {
    const onOpen = vi.fn()
    render(<DayHeader {...base} status={SHORT} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: 'Monday 21 September. 1 shift needs coaches: 1 below the minimum. Open studio overview' })
    expect(btn.getAttribute('type')).toBe('button')
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  // Safari does not focus a button on click, so a dialog that remembers
  // document.activeElement as its opener would hand focus back to the wrong
  // place. The header focuses itself and hands its own element upward.
  it('focuses itself on click and reports its element, so a dialog can return focus to it', () => {
    const onOpen = vi.fn()
    render(<DayHeader {...base} status={OK} onOpen={onOpen} />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    expect(document.activeElement).toBe(btn)
    expect(onOpen).toHaveBeenCalledWith(btn)
  })

  it.each([
    ['ok: a dot and words for a screen reader, NO visible count', OK, 'ok', null, 'Shifts at minimum'],
    ['short: amber, "1 short"', SHORT, 'short', '1 short', SHORT.srLabel],
    ['empty: red, and it SAYS no coach', EMPTY, 'empty', '1 no coach', EMPTY.srLabel],
  ])('%s', (_n, status, tone, visible, sr) => {
    render(<DayHeader {...base} status={status} onOpen={() => {}} />)
    const dot = screen.getByTestId('status-dot')
    expect(dot.getAttribute('data-tone')).toBe(tone)
    expect(dot.getAttribute('title')).toBe(status.title)
    expect(dot.querySelector('.sr-only').textContent).toBe(sr)
    const shown = dot.querySelector('[data-visible-label]')
    if (visible) expect(shown.textContent).toBe(visible)
    else expect(shown).toBeNull()
  })

  // 🔴 Tailwind's sr-only is position:absolute + white-space:nowrap. Inside the
  // roster's horizontal scroller an sr-only span with no positioned ancestor is
  // NOT clipped by that scroller: it widened the whole DOCUMENT to 777px on a
  // 390px phone. jsdom cannot see that (memory `jsdom-cannot-see-layout`); what
  // it can pin is that every sr-only span's parent is itself positioned.
  it('every sr-only span is anchored to a positioned parent, and the header itself is positioned', () => {
    const { container } = render(<DayHeader {...base} isToday status={EMPTY} onOpen={() => {}} />)
    const hidden = container.querySelectorAll('.sr-only')
    expect(hidden.length).toBeGreaterThan(0)
    for (const el of hidden) expect(el.parentElement.className).toMatch(/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/)
    expect(screen.getByTestId('day-header').className).toMatch(/\brelative\b/)
    cleanup()
    // The coach's plain header too: same element, same rule.
    render(<DayHeader {...base} status={null} />)
    expect(screen.getByTestId('day-header').className).toMatch(/\brelative\b/)
  })

  it('both problems: the severe one always shows; the full pair only from 2xl up', () => {
    render(<DayHeader {...base} status={EMPTY} onOpen={() => {}} />)
    const dot = screen.getByTestId('status-dot')
    const narrow = dot.querySelector('[data-visible-label]')
    const wide = dot.querySelector('[data-visible-label-wide]')
    expect(narrow.textContent).toBe('1 no coach')
    expect(narrow.className).toMatch(/2xl:hidden/)
    expect(wide.textContent).toBe('1 no coach · 1 short')
    expect(wide.className).toMatch(/\bhidden\b/)
    expect(wide.className).toMatch(/2xl:inline/)
    // Both are decoration for the eye; the sentence is what is announced.
    expect(narrow.getAttribute('aria-hidden')).toBe('true')
    expect(wide.getAttribute('aria-hidden')).toBe('true')
  })

  it('one problem: one label, no responsive pair', () => {
    render(<DayHeader {...base} status={SHORT} onOpen={() => {}} />)
    const dot = screen.getByTestId('status-dot')
    expect(dot.querySelector('[data-visible-label-wide]')).toBeNull()
    expect(dot.querySelector('[data-visible-label]').className).not.toMatch(/2xl:hidden/)
  })

  it('says nothing for a day with no future shifts', () => {
    render(<DayHeader {...base} status={NONE} onOpen={() => {}} />)
    expect(screen.queryByTestId('status-dot')).toBeNull()
  })

  it('coach: a plain header, no status, nothing to click', () => {
    render(<DayHeader {...base} status={null} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('status-dot')).toBeNull()
    expect(screen.getByTestId('day-header').textContent).toBe('Mon21')
  })

  it('keeps the holiday line and names it in the button', () => {
    render(<DayHeader {...base} holiday={{ name: 'October Bank Holiday', source: 'national' }} status={OK} onOpen={() => {}} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Monday 21 September. October Bank Holiday. Shifts at minimum. Open studio overview')
    expect(screen.getByTestId('day-header').textContent).toContain('October Bank Holiday')
  })

  it('today keeps its solid header; the status rides in its own light pill', () => {
    render(<DayHeader {...base} isToday status={SHORT} onOpen={() => {}} />)
    expect(screen.getByTestId('day-header').className).toMatch(/\bbg-blue-600\b/)
    expect(screen.getByTestId('status-dot').className).toMatch(/\bbg-un1t-bg\b/)
  })
})
