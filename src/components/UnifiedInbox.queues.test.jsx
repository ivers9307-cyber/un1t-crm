// @vitest-environment jsdom
// INBOXFOLLOW.1 — the inbox's five queues, longest-waiting-first sort, row
// chips, the studio's follow-up config from the list response, and the
// one-minute tick that moves threads between queues. Fictional names only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within, act } from '@testing-library/react'

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

const NOW = Date.parse('2026-11-25T12:00:00Z') // a Wednesday
const H = 3600_000
const ago = (ms) => new Date(NOW - ms).toISOString()
const ahead = (ms) => new Date(NOW + ms).toISOString()
const ME = 'u-me'

const waiting = (id, name, hours, extra = {}) => ({
  id, contacts: { name }, last_message_at: ago(hours * H), last_message_direction: 'inbound',
  customer_waiting_since: ago(hours * H), last_message_preview: `${name} preview`, window_expires_at: ahead(10 * H), ...extra,
})

let WA
let IG
let FOLLOWUP

beforeEach(() => {
  FOLLOWUP = { quietHours: 48, nudgeEnabled: false }
  WA = [
    // Newest message first in the list, but the longest wait is Bea.
    waiting('w1', 'Cara Newest', 1),
    waiting('w2', 'Bea Longest', 30),
    { id: 'w3', contacts: { name: 'Dan Mia' }, last_message_at: ago(2 * H), last_message_direction: 'outbound', handoff_requested_at: ago(2 * H), last_message_preview: 'Mia: a person will help', window_expires_at: ahead(2 * H) },
    { id: 'w4', contacts: { name: 'Eve Coach' }, last_message_at: ago(5 * H), last_message_direction: 'outbound', staff_owned_since: ago(5 * H), staff_waiting_since: ago(5 * H), last_message_preview: 'Coach: see you Friday', window_expires_at: ahead(5 * H), assigned_to: ME },
    { id: 'w5', contacts: { name: 'Fay Snoozed' }, last_message_at: ago(6 * H), last_message_direction: 'inbound', customer_waiting_since: ago(6 * H), snoozed_until: '2026-11-27T09:00:00Z', snooze_note: 'Away until Friday', last_message_preview: 'Can I move my class?' },
    { id: 'w6', contacts: { name: 'Gus Approval' }, last_message_at: ago(8 * H), last_message_direction: 'outbound', pending_approval: true, last_message_preview: 'Pending pack', window_expires_at: ago(H) },
  ]
  IG = [{ id: 'i1', ig_username: 'ivy.gram', last_message_at: ago(3 * H), last_message_direction: 'inbound', customer_waiting_since: ago(3 * H), last_message_preview: 'hello?' }]
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      // A search (?q=) answers only the matching threads, as the real routes do.
      const q = new URL(String(url), 'http://localhost').searchParams.get('q')
      const only = (rows) => (q ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) : rows)
      return String(url).includes('instagram')
        ? { success: true, conversations: only(IG) }
        : { success: true, conversations: only(WA), followup: FOLLOWUP }
    },
  })))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function renderInbox(props = {}) {
  render(<UnifiedInbox locationId="l1" userId={ME} timezone="Europe/Dublin" {...props} />)
  await act(async () => {}) // flush the first list read
}

const names = () => screen.getAllByRole('button')
  .map(b => b.textContent)
  .filter(t => /Cara|Bea|Dan|Eve|Fay|Gus|ivy/.test(t))
const chip = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) })

describe('queue chips', () => {
  it('shows the five queues in order with their counts, and opens on Needs reply', async () => {
    await renderInbox()
    const labels = screen.getAllByRole('button').map(b => b.textContent).filter(t => /^(Needs reply|Mia needs help|Waiting|Approvals|All)/.test(t))
    expect(labels.map(l => l.replace(/\W+/g, ' ').trim())).toEqual(['Needs reply 3', 'Mia needs help 1', 'Waiting 2', 'Approvals 1', 'All'])
    // Needs reply is selected: the answered, snoozed and Mia-only threads are not listed.
    expect(names().map(n => n.replace(/ preview.*/, '')).length).toBe(3)
  })

  it('Needs reply lists the longest wait first; the other queues keep newest first', async () => {
    await renderInbox()
    expect(names().map(n => /Bea|ivy|Cara/.exec(n)[0])).toEqual(['Bea', 'ivy', 'Cara'])
    fireEvent.click(chip('All'))
    expect(names().map(n => /Cara|Bea|Dan|Eve|Fay|Gus|ivy/.exec(n)[0])).toEqual(['Cara', 'Dan', 'ivy', 'Eve', 'Fay', 'Gus', 'Bea'])
  })

  it('Mia needs help, Waiting and Approvals each show their own threads', async () => {
    await renderInbox()
    fireEvent.click(chip('Mia needs help'))
    expect(names()).toHaveLength(1)
    expect(names()[0]).toContain('Dan Mia')
    fireEvent.click(chip('Waiting'))
    expect(names().map(n => /Eve|Fay/.exec(n)[0]).sort()).toEqual(['Eve', 'Fay'])
    fireEvent.click(chip('Approvals'))
    expect(names()).toHaveLength(1)
    expect(names()[0]).toContain('Gus Approval')
  })

  it('the owner filter narrows every queue', async () => {
    await renderInbox()
    fireEvent.click(chip('Waiting'))
    const group = screen.getByRole('group', { name: 'Filter by owner' })
    fireEvent.click(within(group).getByRole('button', { name: 'Mine' }))
    expect(names()).toHaveLength(1)
    expect(names()[0]).toContain('Eve Coach')
  })
})

describe('rows', () => {
  it('shows the wait chip and window chip, and the amber Needs human badge', async () => {
    await renderInbox()
    expect(screen.getAllByTestId('wait-chip').map(c => c.textContent)).toEqual(['waiting 1 day', 'waiting 3h', 'waiting 1h'])
    expect(screen.getAllByTestId('window-chip').map(c => c.textContent)).toEqual(['closes in 10h', 'closes in 10h'])
    fireEvent.click(chip('Mia needs help'))
    expect(screen.getByText('Needs human')).toBeTruthy()
    expect(screen.getByTestId('window-chip').textContent).toBe('closes in 2h')
  })

  it('a coach-owned thread says quiet, and a snoozed one replaces its preview with the snooze line', async () => {
    await renderInbox()
    fireEvent.click(chip('Waiting'))
    expect(screen.getByTestId('wait-chip').textContent).toBe('quiet 5h')
    expect(screen.getByTestId('state-line').textContent).toBe('Snoozed until Fri 09:00 · Away until Friday')
    expect(screen.queryByText('Can I move my class?')).toBeNull()
    expect(screen.getByText('Coach: see you Friday')).toBeTruthy()
  })

  it('Mark handled shows on rows that need a reply or Mia\'s help, and not on a waiting row', async () => {
    await renderInbox()
    expect(screen.getAllByTitle('Mark handled — no reply needed')).toHaveLength(3)
    fireEvent.click(chip('Mia needs help'))
    expect(screen.getAllByTitle('Mark handled — hand back to the agent')).toHaveLength(1)
    fireEvent.click(chip('Waiting'))
    expect(screen.queryAllByTitle(/Mark handled/)).toHaveLength(0)
  })
})

describe('search and config', () => {
  it('search ignores the queue chips', async () => {
    await renderInbox()
    fireEvent.change(screen.getByPlaceholderText('Search people & messages'), { target: { value: 'Gus' } })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(names()).toHaveLength(1)
    expect(names()[0]).toContain('Gus Approval')
  })

  it('uses the studio\'s quiet window from the list response', async () => {
    // Replied 10 h ago: inside a 48 h window it waits; a 4 h window brings it back.
    WA = [{ id: 'w4', contacts: { name: 'Eve Coach' }, last_message_at: ago(10 * H), last_message_direction: 'outbound', staff_owned_since: ago(10 * H), staff_waiting_since: ago(10 * H), last_message_preview: 'Coach: see you Friday' }]
    IG = []
    await renderInbox()
    expect(screen.queryByText('Eve Coach')).toBeNull()
    cleanup()
    FOLLOWUP = { quietHours: 4, nudgeEnabled: false }
    await renderInbox()
    expect(screen.getByText('Eve Coach')).toBeTruthy()
    expect(screen.getByTestId('state-line').textContent).toBe('Gone quiet')
  })
})

describe('the one-minute tick', () => {
  it('moves a thread from Waiting to Needs reply when its quiet window ends, with no reload', async () => {
    // Quiet for 47 h 40 m of a 48 h window: it comes back in 20 minutes.
    WA = [{ id: 'w4', contacts: { name: 'Eve Coach' }, last_message_at: ago(47 * H + 40 * 60_000), last_message_direction: 'outbound', staff_owned_since: ago(48 * H), staff_waiting_since: ago(47 * H + 40 * 60_000), last_message_preview: 'Coach: see you Friday' }]
    IG = []
    await renderInbox()
    expect(screen.queryByText('Eve Coach')).toBeNull()
    expect(chip('Waiting').textContent).toMatch(/^Waiting\W*1$/)
    await act(async () => { vi.advanceTimersByTime(21 * 60_000) })
    expect(screen.getByText('Eve Coach')).toBeTruthy()
    expect(chip('Needs reply').textContent).toMatch(/^Needs reply\W*1$/)
    expect(chip('Waiting').textContent).toBe('Waiting')
  })
})
