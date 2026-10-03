// @vitest-environment jsdom
//
// AVAIL.3 — "My roster"'s header: a contractor gets a My availability link
// where everyone else gets "Request time off".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MonthRoster from './MonthRoster'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const weeks = [[{ iso: '2099-06-10', dayNum: 10, inMonth: true, isToday: false, isPast: false, shifts: [] }]]
const renderFor = (employmentType) =>
  render(<MonthRoster weeks={weeks} monthLabel="June 2099" monthSummary="" weekPanels={[]} employmentType={employmentType} />)

afterEach(() => cleanup())

describe('MonthRoster header — AVAIL.3', () => {
  it('a contractor gets a My availability link, no Request time off button', () => {
    renderFor('contractor')
    expect(screen.getByRole('link', { name: 'My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: 'Request time off' })).toBeNull()
  })

  it('an employee (or unknown employment) keeps Request time off', () => {
    renderFor('fte')
    expect(screen.getByRole('button', { name: 'Request time off' })).toBeTruthy()
    cleanup()
    renderFor(undefined)
    expect(screen.getByRole('button', { name: 'Request time off' })).toBeTruthy()
  })
})
