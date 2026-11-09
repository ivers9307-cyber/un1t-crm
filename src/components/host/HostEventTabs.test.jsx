// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

let pathname = '/host/events/e1'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: React.forwardRef(function Link({ href, children, ...rest }, ref) { return <a ref={ref} href={href} {...rest}>{children}</a> }) }
})
const { default: HostEventTabs, activeTab, EVENT_TABS } = await import('./HostEventTabs.jsx')

afterEach(() => cleanup())

describe('activeTab', () => {
  it('maps each path to its tab, and /edit to setup', () => {
    expect(activeTab('/host/events/e1', 'e1')).toBe('overview')
    expect(activeTab('/host/events/e1/', 'e1')).toBe('overview')
    expect(activeTab('/host/events/e1/attendees', 'e1')).toBe('attendees')
    expect(activeTab('/host/events/e1/setup', 'e1')).toBe('setup')
    expect(activeTab('/host/events/e1/edit', 'e1')).toBe('setup')
    expect(activeTab('/host/events/e1/promote', 'e1')).toBe('promote')
    expect(activeTab('/host/events/e1/insights', 'e1')).toBe('insights')
  })
})

describe('HostEventTabs', () => {
  it('links every tab under the event and marks the current one', () => {
    pathname = '/host/events/e1/promote'
    render(<HostEventTabs eventId="e1" attendeeCount={null} />)
    expect(EVENT_TABS.map((t) => t.label)).toEqual(['Overview', 'Attendees', 'Set up', 'Promote', 'Insights'])
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/host/events/e1')
    expect(screen.getByRole('link', { name: 'Set up' }).getAttribute('href')).toBe('/host/events/e1/setup')
    expect(screen.getByRole('link', { name: 'Promote' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()
  })
  it('shows the attendee count only when it is a number', () => {
    pathname = '/host/events/e1'
    const { unmount } = render(<HostEventTabs eventId="e1" attendeeCount={0} />)
    expect(screen.getByRole('link', { name: /Attendees/ }).textContent).toContain('0')
    unmount()
    render(<HostEventTabs eventId="e1" attendeeCount={null} />)
    expect(screen.getByRole('link', { name: /Attendees/ }).textContent).toBe('Attendees')
  })
})
