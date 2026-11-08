// @vitest-environment jsdom
// HOSTSTATS.1 — every /event/* page (the event page, the series page, the
// confirmed page) keeps the tab's first-touch attribution, so a reader who
// lands on a series page from a host email and picks a date still books as
// host_email.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/default-site-name', () => ({ customerFacingMetadata: async () => ({}) }))
vi.mock('@/components/EventAttributionCapture', () => ({ default: function EventAttributionCapture() { return <span data-testid="capture" /> } }))

const { default: EventLayout } = await import('./layout.js')

afterEach(cleanup)

describe('/event layout', () => {
  it('mounts the attribution capture once around its children', () => {
    render(<EventLayout><p>child</p></EventLayout>)
    expect(screen.getAllByTestId('capture').length).toBe(1)
    expect(screen.getByText('child')).toBeTruthy()
  })
})
