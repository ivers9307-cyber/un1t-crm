// @vitest-environment jsdom
//
// OPENWEEK.1 — the open week class picker: every slot of the window by day,
// several picks within the limits, a running count on the continue button.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import OpenWeekPickStep, { togglePick, dayRows } from './OpenWeekPickStep'

const cls = (id, day, time = '07:00') => ({ event_id: id, name: `Class ${id}`, starts_at: `${day}T${time}:00.000Z`, day, day_label: `Tue, ${day.slice(8)} Nov`, time })
const CLASSES = [cls('a', '2026-11-24'), cls('a2', '2026-11-24', '18:00'), cls('b', '2026-11-25'), cls('c', '2026-11-26'), cls('d', '2026-11-27'), cls('e', '2026-11-28'), cls('f', '2026-11-29')]
const LIMITS = { maxClasses: 5, maxPerDay: 1 }
const COPY = { pick_heading: 'Pick your classes', pick_hint: 'One class a day, up to 5.', pick_cta: 'Continue with {count} classes', no_classes_text: 'Nothing open', timetable_unavailable_text: 'Try later' }
const list = (classes = CLASSES, extra = {}) => ({ classes, loading: false, configured: true, unavailable: false, ...extra })

afterEach(cleanup)

describe('togglePick', () => {
  it('adds, removes, replaces the same day, and refuses past the most', () => {
    let r = togglePick([], CLASSES[0], LIMITS)
    expect(r).toEqual({ picks: [CLASSES[0]], refused: null })
    expect(togglePick(r.picks, CLASSES[0], LIMITS)).toEqual({ picks: [], refused: null })
    r = togglePick([CLASSES[0]], CLASSES[1], LIMITS)
    expect(r).toEqual({ picks: [CLASSES[1]], refused: null })
    const five = [CLASSES[0], CLASSES[2], CLASSES[3], CLASSES[4], CLASSES[5]]
    expect(togglePick(five, CLASSES[6], LIMITS)).toEqual({ picks: five, refused: 'too_many' })
  })

  it('with two a day allowed, a third on that day is refused', () => {
    const twoADay = { maxClasses: 5, maxPerDay: 2 }
    const third = cls('a3', '2026-11-24', '20:00')
    expect(togglePick([CLASSES[0], CLASSES[1]], third, twoADay)).toEqual({ picks: [CLASSES[0], CLASSES[1]], refused: 'day_full' })
  })
})

describe('dayRows (OPENWEEK picker rows)', () => {
  it('one row per day, the most common class named first, the others named with their time', () => {
    const named = (id, day, time, name) => ({ ...cls(id, day, time), name })
    const rows = dayRows([
      named('m1', '2026-11-23', '06:00', 'FORCE.'), named('m2', '2026-11-23', '07:00', 'FORCE.'),
      named('m3', '2026-11-23', '11:00', 'THE 50+ CLUB'), named('t1', '2026-11-24', '06:00', 'RECLA1M'),
    ])
    expect(rows.map((r) => r.day)).toEqual(['2026-11-23', '2026-11-24'])
    expect(rows[0].main).toBe('FORCE.')
    expect(rows[0].label).toBe('FORCE. · THE 50+ CLUB 11:00')
    expect(rows[0].classes.map((c) => c.special)).toEqual([false, false, true])
    expect(rows[1].label).toBe('RECLA1M')
  })
})

describe('OpenWeekPickStep', () => {
  const mount = (props = {}) => render(<OpenWeekPickStep list={list()} copy={COPY} {...LIMITS} picks={[]} onChange={() => {}} onContinue={() => {}} {...props} />)

  it('shows one row per day with time-only pills named for screen readers, typed buttons, heading and hint', () => {
    mount()
    expect(screen.getByText('Pick your classes')).toBeTruthy()
    expect(screen.getByText('One class a day, up to 5.')).toBeTruthy()
    expect(screen.getAllByRole('group')).toHaveLength(6)
    const slots = screen.getAllByRole('button', { pressed: false })
    expect(slots.map((b) => b.getAttribute('data-slot'))).toEqual(['a', 'a2', 'b', 'c', 'd', 'e', 'f'])
    expect(slots[0].textContent).toBe('07:00')
    expect(slots[0].getAttribute('aria-label')).toBe('07:00 Class a')
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type')).toBe('button')
  })

  it('a dot per allowed class fills as they pick', () => {
    const { container } = mount({ picks: [CLASSES[0], CLASSES[2]] })
    const dots = container.querySelectorAll('[data-dot]')
    expect(dots).toHaveLength(5)
    expect([...dots].filter((d) => d.getAttribute('data-dot') === 'on')).toHaveLength(2)
  })

  it('tapping reports the new picks; a same-day tap replaces', () => {
    const onChange = vi.fn()
    mount({ picks: [CLASSES[0]], onChange })
    fireEvent.click(screen.getByRole('button', { name: /Class a2/ }))
    expect(onChange).toHaveBeenCalledWith([CLASSES[1]])
  })

  it('a sixth pick is refused with the hint shown as the reason', () => {
    const onChange = vi.fn()
    mount({ picks: [CLASSES[0], CLASSES[2], CLASSES[3], CLASSES[4], CLASSES[5]], onChange })
    fireEvent.click(screen.getByRole('button', { name: /Class f/ }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('One class a day, up to 5.')
  })

  it('the continue button counts the picks and is disabled at none', () => {
    const onContinue = vi.fn()
    mount()
    expect(screen.getByRole('button', { name: 'Continue with 0 classes' }).disabled).toBe(true)
    cleanup()
    mount({ picks: [CLASSES[0], CLASSES[2]], onContinue })
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 2 classes' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('says so when the timetable cannot be read or is empty', () => {
    mount({ list: list([], { unavailable: true }) })
    expect(screen.getByText('Try later')).toBeTruthy()
    cleanup()
    mount({ list: list([]) })
    expect(screen.getByText('Nothing open')).toBeTruthy()
  })
})
