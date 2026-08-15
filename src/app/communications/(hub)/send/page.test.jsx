// @vitest-environment jsdom
//
// SEGPICK.1 — /communications/send takes TWO different deep links and they are
// not interchangeable:
//   ?segment=<tag>     → seeds a { field: 'tag' } clause (mig 085 machine tags)
//   ?segment_id=<uuid> → applies a saved contact_segments filter wholesale
// The tag form predates this change and must keep working untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/components/communications/UnifiedSendComposer', () => ({
  default: (props) => <div data-testid="composer-props">{JSON.stringify(props)}</div>,
}))

import SendPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => {
  cleanup()
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' } })
  // WhatsApp templates query — chainable stub ending in an awaited order().
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) }),
    }),
  })
})

async function renderWith(searchParams) {
  render(await SendPage({ searchParams: Promise.resolve(searchParams) }))
  return JSON.parse(screen.getByTestId('composer-props').textContent)
}

describe('/communications/send deep links', () => {
  it('passes ?segment_id through as initialSegmentId, with no filter seeded', async () => {
    const props = await renderWith({ segment_id: 'seg-9' })
    expect(props.initialSegmentId).toBe('seg-9')
    expect(props.initialAudienceFilter).toBeNull()
  })

  it('still seeds a tag clause for the older ?segment=<tag> link', async () => {
    const props = await renderWith({ segment: 'race-2026' })
    expect(props.initialAudienceFilter).toEqual({
      logic: 'and', filters: [{ field: 'tag', op: 'eq', value: 'race-2026' }],
    })
    expect(props.initialSegmentId).toBeNull()
  })

  it('seeds neither when no deep link is present', async () => {
    const props = await renderWith({})
    expect(props.initialAudienceFilter).toBeNull()
    expect(props.initialSegmentId).toBeNull()
  })
})
