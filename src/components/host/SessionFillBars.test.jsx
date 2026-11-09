// @vitest-environment jsdom
// HOSTPORTAL.2 — per-session fill bars on the Overview tab.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SessionFillBars from './SessionFillBars'

const s = (over) => ({ id: 's1', label: null, time: '10:00', capacity: 30, booked: 8, full: false, ...over })
const fillOf = (container) => container.querySelector('[data-fill]')

describe('SessionFillBars', () => {
  it('reads "30 / 30 · full" for a full session', () => {
    render(<SessionFillBars sessions={[s({ booked: 30, full: true })]} />)
    expect(screen.getByText('30 / 30 · full')).toBeTruthy()
  })
  it('reads "8 / 30" for a part-filled session, with a proportional bar', () => {
    const { container } = render(<SessionFillBars sessions={[s()]} />)
    expect(screen.getByText('8 / 30')).toBeTruthy()
    expect(fillOf(container).style.width).toBe(`${(8 / 30) * 100}%`)
  })
  it('reads "3 booked" with no bar when capacity is null', () => {
    const { container } = render(<SessionFillBars sessions={[s({ capacity: null, booked: 3 })]} />)
    expect(screen.getByText('3 booked')).toBeTruthy()
    expect(fillOf(container)).toBeNull()
  })
  it('labels "10:00 · Morning" with a label and "10:00" without', () => {
    render(<SessionFillBars sessions={[s({ id: 'a', label: 'Morning' }), s({ id: 'b', time: '12:00' })]} />)
    expect(screen.getByText('10:00 · Morning')).toBeTruthy()
    expect(screen.getByText('12:00')).toBeTruthy()
  })
  it('never draws a bar wider than 100%', () => {
    const { container } = render(<SessionFillBars sessions={[s({ booked: 45, capacity: 30, full: true })]} />)
    expect(fillOf(container).style.width).toBe('100%')
  })
})
