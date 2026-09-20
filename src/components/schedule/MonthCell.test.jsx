// src/components/schedule/MonthCell.test.jsx
// @vitest-environment jsdom
//
// ROSTERLOOK.1 — a month cell names the coaches and speaks the same status
// language as the week headers. Text, titles and presence only (memory
// `jsdom-cannot-see-layout`).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MonthCell from '@/components/schedule/MonthCell'

afterEach(() => cleanup())

const LINES = [
  { id: 'a', tone: 'ok', text: '5:45 Alex, Blake', title: 'HIIT · 5:45–6:45am · Alex First, Blake Second' },
  { id: 'b', tone: 'short', text: '6:45 Casey (1 of 2)', title: 'HIIT · 6:45–7:45am · Casey Third · Below minimum: 1 of 2 coaches' },
  { id: 'c', tone: 'empty', text: '5:45pm Needs coach', title: 'Evening · 5:45–6:45pm · No coach is assigned to this shift' },
]
const STATUS = { tone: 'empty', label: '2 short', srLabel: '2 shifts need coaches: 1 with no coach, 1 below the minimum', title: '2 shifts need coaches: 1 with no coach, 1 below the minimum' }
const base = { dayNumber: 22, inFocusedMonth: true, isToday: false, holiday: null, lines: LINES, more: 4, status: STATUS, assignmentCount: 3, timeOffEntry: null }

describe('MonthCell', () => {
  it('is one button that drills into its week', () => {
    const onOpen = vi.fn()
    render(<MonthCell {...base} onOpen={onOpen} />)
    const cell = screen.getByRole('button')
    expect(cell.getAttribute('type')).toBe('button')
    expect(cell.querySelector('button, a')).toBeNull() // nothing interactive nested inside it
    fireEvent.click(cell)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('each line reads time + first names, with the full story in its title', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const lines = screen.getAllByTestId('month-line')
    expect(lines.map((l) => l.textContent)).toEqual(LINES.map((l) => l.text))
    expect(lines.map((l) => l.getAttribute('title'))).toEqual(LINES.map((l) => l.title))
  })

  it('status colour is on the unstaffed and short lines only, and the empty one is dashed', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const [ok, short, empty] = screen.getAllByTestId('month-line')
    expect(ok.getAttribute('data-tone')).toBe('ok')
    expect(ok.className).not.toMatch(/amber|red/)
    expect(short.className).toMatch(/text-amber-700/)
    expect(empty.className).toMatch(/text-red-700/)
    expect(empty.className).toMatch(/border-dashed/)
  })

  it('no line is tinted by a template colour', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    for (const l of screen.getAllByTestId('month-line')) expect(l.getAttribute('style')).toBeNull()
  })

  it('"+N more" stays', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    expect(screen.getByText('+4 more')).toBeTruthy()
    cleanup()
    render(<MonthCell {...base} more={0} onOpen={() => {}} />)
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('"!1" and "↓1" are gone: the status is the week headers\' dot, with words and a title', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const cell = screen.getByRole('button')
    expect(cell.textContent).not.toMatch(/[!↓]\d/)
    const dot = screen.getByTestId('status-dot')
    expect(dot.getAttribute('data-tone')).toBe('empty')
    expect(dot.getAttribute('title')).toBe(STATUS.title)
    expect(dot.textContent).toContain('2 short')
    expect(dot.querySelector('.sr-only').textContent).toBe(STATUS.srLabel)
  })

  it('the bare assignment count says what it counts', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const count = screen.getByTestId('month-assignment-count')
    expect(count.getAttribute('title')).toBe('3 coach assignments')
    expect(count.querySelector('.sr-only').textContent).toBe(' coach assignments')
  })

  // 🔴 Tailwind's sr-only is position:absolute + white-space:nowrap. Inside the
  // roster's horizontal scroller an sr-only span with no positioned ancestor is
  // NOT clipped by that scroller: it widened the whole DOCUMENT to 777px on a
  // 390px phone. jsdom cannot see that (memory `jsdom-cannot-see-layout`); what
  // it can pin is that every sr-only span's parent is itself positioned.
  it('every sr-only span is anchored to a positioned parent, and the cell itself is positioned', () => {
    render(<MonthCell {...base} onOpen={() => {}} />)
    const cell = screen.getByRole('button')
    const hidden = cell.querySelectorAll('.sr-only')
    expect(hidden.length).toBe(2)
    for (const el of hidden) expect(el.parentElement.className).toMatch(/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/)
    expect(cell.className).toMatch(/\brelative\b/)
  })

  it('coach: no status at all', () => {
    render(<MonthCell {...base} status={null} lines={[LINES[0]]} onOpen={() => {}} />)
    expect(screen.queryByTestId('status-dot')).toBeNull()
  })

  it('keeps the holiday name and the first time-off entry', () => {
    render(<MonthCell {...base} holiday={{ name: 'October Bank Holiday' }} timeOffEntry={{ text: 'Sarah Holiday', color: '#22C55E' }} onOpen={() => {}} />)
    expect(screen.getByText('October Bank Holiday').getAttribute('title')).toBe('October Bank Holiday')
    expect(screen.getByText('Sarah Holiday')).toBeTruthy()
  })
})
