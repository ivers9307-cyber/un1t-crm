// @vitest-environment jsdom
// INBOXASSIGN.1 — the inbox list's Anyone / Mine / Unassigned filter, and the
// owner shown on each row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({ default: () => <div /> }))
vi.mock('@/components/WAInbox', () => ({ default: () => <div /> }))
vi.mock('@/components/IGInbox', () => ({ default: () => <div /> }))

import UnifiedInbox from './UnifiedInbox.jsx'

const ME = 'u-me'
const now = new Date().toISOString()
const WA = [
  { id: 'w1', contacts: { name: 'Mine Customer' }, assigned_to: ME, assignee_name: 'Test Manager', last_message_at: now, last_message_preview: 'hi' },
  { id: 'w2', contacts: { name: 'Colleague Customer' }, assigned_to: 'u-alex', assignee_name: 'Alex Example', last_message_at: now, last_message_preview: 'hi' },
  { id: 'w3', contacts: { name: 'Nobody Customer' }, assigned_to: null, last_message_at: now, last_message_preview: 'hi' },
]
const IG = [
  { id: 'i1', ig_username: 'unowned.gram', assigned_to: null, last_message_at: now, last_message_preview: 'yo' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, conversations: String(url).includes('instagram') ? IG : WA }),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function renderInbox() {
  render(<UnifiedInbox locationId="l1" userId={ME} />)
  // "All" queue, so needs-reply does not hide rows.
  fireEvent.click(screen.getByRole('button', { name: 'All' }))
  await screen.findByText('Mine Customer')
}

describe('UnifiedInbox owner filter', () => {
  it('Anyone shows every row, with the owner on owned rows', async () => {
    await renderInbox()
    for (const n of ['Mine Customer', 'Colleague Customer', 'Nobody Customer', '@unowned.gram']) {
      expect(screen.getByText(n)).toBeTruthy()
    }
    const tags = screen.getAllByTestId('owner-tag').map(t => t.textContent)
    expect(tags.sort()).toEqual(['Alex', 'You'])
  })

  it('Mine shows only threads assigned to the viewer', async () => {
    await renderInbox()
    const group = screen.getByRole('group', { name: 'Filter by owner' })
    fireEvent.click(within(group).getByRole('button', { name: 'Mine' }))
    expect(screen.getByText('Mine Customer')).toBeTruthy()
    expect(screen.queryByText('Colleague Customer')).toBeNull()
    expect(screen.queryByText('Nobody Customer')).toBeNull()
    expect(within(group).getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('Unassigned shows only unowned threads, on both channels', async () => {
    await renderInbox()
    const group = screen.getByRole('group', { name: 'Filter by owner' })
    fireEvent.click(within(group).getByRole('button', { name: 'Unassigned' }))
    expect(screen.getByText('Nobody Customer')).toBeTruthy()
    expect(screen.getByText('@unowned.gram')).toBeTruthy()
    expect(screen.queryByText('Mine Customer')).toBeNull()
    expect(screen.queryByText('Colleague Customer')).toBeNull()
  })

  it('says so when the filter leaves nothing', async () => {
    fetch.mockImplementation(async (url) => ({ ok: true, status: 200, json: async () => ({ success: true, conversations: String(url).includes('instagram') ? [] : [WA[2]] }) }))
    render(<UnifiedInbox locationId="l1" userId={ME} />)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await screen.findByText('Nobody Customer')
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter by owner' })).getByRole('button', { name: 'Mine' }))
    expect(screen.getByText('Nothing assigned to you here.')).toBeTruthy()
  })
})
