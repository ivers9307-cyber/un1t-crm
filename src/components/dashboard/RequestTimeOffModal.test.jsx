// @vitest-environment jsdom
//
// AVAIL.3 — the dashboard's time-off modal: a contractor has nothing to
// request ("unavailable" moved into availability), so the modal points at My
// availability instead of showing a one-option form; an employee's form never
// offers Unavailable.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import RequestTimeOffModal from './RequestTimeOffModal'

afterEach(() => cleanup())

describe('RequestTimeOffModal — AVAIL.3', () => {
  it('a contractor gets My availability, not a form', () => {
    render(<RequestTimeOffModal open onClose={() => {}} employmentType="contractor" />)
    expect(screen.getByText('Use My availability instead')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open My availability' }).getAttribute('href')).toBe('/schedule/availability')
    expect(screen.queryByRole('button', { name: 'Submit request' })).toBeNull()
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('an employee still gets the four leave types, and no Unavailable', () => {
    render(<RequestTimeOffModal open onClose={() => {}} employmentType="fte" />)
    const options = Array.from(screen.getByLabelText('Type').options).map((o) => o.value)
    expect(options).toEqual(['holiday', 'sick', 'unpaid', 'other'])
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeTruthy()
  })
})
