// @vitest-environment jsdom
// APPROVALSQ.6 — a link to a page of another studio switches the active studio
// first (the location switcher's own cookie write), then opens the page.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

import StudioLink from './StudioLink'

beforeEach(() => {
  router.push.mockReset(); router.refresh.mockReset()
  document.cookie = 'un1t_active_location=; path=/; max-age=0'
})
afterEach(cleanup)

const here = { studioId: 'studio-1', studioName: 'Stillorgan' }
const there = { studioId: 'studio-2', studioName: 'Hatch Street' }

describe('StudioLink', () => {
  it('an item at the active studio is a plain link', () => {
    render(<StudioLink item={here} activeStudioId="studio-1" href="/communications/inbox?c=1" className="x">Open conversation</StudioLink>)
    const a = screen.getByRole('link', { name: 'Open conversation' })
    expect(a.getAttribute('href')).toBe('/communications/inbox?c=1')
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('an item with no studio (the This studio view) is a plain link', () => {
    render(<StudioLink item={{ id: 'a' }} activeStudioId="studio-1" href="/x">Full history</StudioLink>)
    expect(screen.getByRole('link', { name: 'Full history' })).toBeTruthy()
  })
  it('an item at another studio is a button that says where it goes, and does not navigate on render', () => {
    render(<StudioLink item={there} activeStudioId="studio-1" href="/schedule/invoices?focus=v1">Open in Invoices</StudioLink>)
    expect(screen.queryByRole('link')).toBeNull()
    const b = screen.getByRole('button', { name: 'Switch to Hatch Street and open' })
    expect(b.getAttribute('type')).toBe('button')
    expect(router.push).not.toHaveBeenCalled()
    expect(document.cookie).not.toContain('un1t_active_location=studio-2')
  })
  it('pressing it sets the active studio cookie, then navigates', () => {
    render(<StudioLink item={there} activeStudioId="studio-1" href="/schedule/invoices?focus=v1">Open in Invoices</StudioLink>)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Hatch Street and open' }))
    expect(document.cookie).toContain('un1t_active_location=studio-2')
    expect(router.push).toHaveBeenCalledWith('/schedule/invoices?focus=v1')
    expect(router.refresh).toHaveBeenCalled()
  })
  it('without an active studio id it still switches (never opens another studio unswitched)', () => {
    render(<StudioLink item={there} activeStudioId={null} href="/x">Open</StudioLink>)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Hatch Street and open' }))
    expect(document.cookie).toContain('un1t_active_location=studio-2')
  })
  it('asButton renders the primary Open button, for a studio switch too', () => {
    const { unmount } = render(<StudioLink asButton item={here} activeStudioId="studio-1" href="/x">Open</StudioLink>)
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/x')
    unmount()
    render(<StudioLink asButton item={there} activeStudioId="studio-1" href="/x">Open</StudioLink>)
    expect(screen.getByRole('button', { name: 'Switch to Hatch Street and open' })).toBeTruthy()
  })
  it('a studio with no name still reads sensibly', () => {
    render(<StudioLink item={{ studioId: 'studio-2' }} activeStudioId="studio-1" href="/x">Open</StudioLink>)
    expect(screen.getByRole('button', { name: 'Switch studio and open' })).toBeTruthy()
  })
})
