// @vitest-environment jsdom
// APPROVALSQ.3 — UnifiedInbox hands the studio's zone to the channel inbox it embeds.
// Drop the prop on either hop and the approval cards inside quietly fall back to
// the platform zone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({ default: () => <div /> }))
vi.mock('@/components/WAInbox', () => ({ default: ({ timezone }) => <div data-testid="wa" data-tz={timezone ?? ''} /> }))
vi.mock('@/components/IGInbox', () => ({ default: ({ timezone }) => <div data-testid="ig" data-tz={timezone ?? ''} /> }))

import UnifiedInbox from './UnifiedInbox.jsx'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, conversations: [] }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('UnifiedInbox timezone threading', () => {
  it('passes timezone to WAInbox', async () => {
    render(<UnifiedInbox locationId="l1" timezone="America/New_York" initialConversationId="c1" initialChannel="wa" />)
    expect((await screen.findByTestId('wa')).getAttribute('data-tz')).toBe('America/New_York')
  })
  it('passes timezone to IGInbox', async () => {
    render(<UnifiedInbox locationId="l1" timezone="America/New_York" initialConversationId="c1" initialChannel="ig" />)
    expect((await screen.findByTestId('ig')).getAttribute('data-tz')).toBe('America/New_York')
  })
})
