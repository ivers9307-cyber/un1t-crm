// @vitest-environment jsdom
//
// PAGES.1 — the one timetable read-back, used by the studio rows and the
// legacy class_funnel editor (studio pages, until PR3).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import { TimetableReadBack } from './timetable-read-back'
import LandingPageSettingsForm from '@/components/LandingPageSettingsForm'
import { newBlockOfType } from '@/lib/landing-page-blocks'

const TEXT = 'Mon-Tue 06:15 Strength\nSat 9am Conditioning\nwhenever'

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, memberships: [] }) }))
})
afterEach(() => cleanup())

function expectReadBack(container) {
  expect(screen.getByText('How it reads (3 class times a week):')).toBeTruthy()
  const lines = [...container.querySelectorAll('p')].map((p) => p.textContent)
  expect(lines).toContain('Mon 06:15 Strength')
  expect(lines).toContain('Tue 06:15 Strength')
  expect(lines).toContain('Sat 09:00 Conditioning')
  expect(screen.getByText('Not understood, so not shown to visitors:')).toBeTruthy()
  expect(screen.getByText('whenever')).toBeTruthy()
}

describe('TimetableReadBack', () => {
  it('reads the times by weekday and lists the lines it could not read', () => {
    const { container } = render(<TimetableReadBack text={TEXT} />)
    expectReadBack(container)
  })

  it('renders nothing for a blank timetable, and says when nothing reads', () => {
    const { container } = render(<TimetableReadBack text="  " />)
    expect(container.innerHTML).toBe('')
    cleanup()
    render(<TimetableReadBack text="whenever" />)
    expect(screen.getByText('No class times could be read yet.')).toBeTruthy()
  })

  it('the legacy class_funnel editor shows the same read-back', () => {
    const block = { ...newBlockOfType('class_funnel'), id: 'b-cf', timetable: TEXT }
    const { container } = render(
      <LandingPageSettingsForm locationId="loc-s" initialSettings={{ blocks: [block] }} availableBookingTypes={[]} />,
    )
    expectReadBack(container)
  })
})
