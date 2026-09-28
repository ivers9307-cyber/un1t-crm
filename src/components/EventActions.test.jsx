// @vitest-environment jsdom
//
// ROLEUI.1 — the booking type's Delete button shows only when the caller may
// delete it. It used to show to everyone who could open the page, and a
// caller the route refuses (not Manager+ at the booking type's studio) got
// "Not found" on click. The page decides (canManageEventType) and passes
// canDelete; the default is false, so a caller that forgets it hides the
// button rather than offering one that fails. Preview and Embed are the
// public booking link, not an API call, and stay for everyone.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import EventActions from './EventActions'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

afterEach(cleanup)

describe('EventActions', () => {
  it('shows Delete when canDelete', () => {
    render(<EventActions slug="pt-consult" eventId="evt-1" eventName="PT Consult" canDelete />)
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeNull()
  })

  it('hides Delete without canDelete (the default), and keeps Preview and Embed', () => {
    render(<EventActions slug="pt-consult" eventId="evt-1" eventName="PT Consult" />)
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /preview/i })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /embed/i })).not.toBeNull()
  })
})
