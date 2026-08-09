// @vitest-environment jsdom
//
// SEGPICK.1 — the Segments tab must show BOTH groups, kept visually separate:
// the hardcoded machine tag cards (SegmentsGrid) and the location's own saved
// filters (SavedSegmentsList). Before this, only the tag cards rendered, so a
// segment saved on /contacts appeared nowhere in Communications.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('@/components/SegmentsGrid', () => ({ default: () => <div data-testid="tag-cards" /> }))
vi.mock('@/components/SavedSegmentsList', () => ({
  default: (props) => <div data-testid="saved-segments">{JSON.stringify(props)}</div>,
}))

import SegmentsTabPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

beforeEach(() => {
  cleanup()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', activeLocation: { id: 'loc-1' } })
})

describe('/communications/segments', () => {
  it('renders the saved-segment group as well as the tag cards', async () => {
    render(await SegmentsTabPage())
    expect(screen.getByTestId('tag-cards')).toBeTruthy()
    expect(screen.getByTestId('saved-segments')).toBeTruthy()
  })

  it('scopes the saved segments to the active location', async () => {
    render(await SegmentsTabPage())
    expect(JSON.parse(screen.getByTestId('saved-segments').textContent).locationId).toBe('loc-1')
  })

  it('names both groups so the two senses of "segment" stay distinct', async () => {
    render(await SegmentsTabPage())
    const headings = screen.getAllByRole('heading').map(h => h.textContent)
    expect(headings).toContain('Saved segments')
    expect(headings).toContain('Tag audiences')
  })
})
