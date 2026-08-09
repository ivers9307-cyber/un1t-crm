// @vitest-environment jsdom
//
// FILTER-B.3 — the count is mounted in EVERY builder host, and each host asks
// for its own channel.
//
// Three of the five hosts shipped with `audienceCount={null}`: WhatsApp
// broadcast, SMS broadcast and sequence settings rendered the filter builder
// with no number at all, so every defect the correctness phase fixed was
// invisible there. This pins both halves of the fix: the count is present,
// and it is the RIGHT count (a WhatsApp broadcast must not be shown an
// email-reachable number).
//
// FILTER-FOUND row 1 is closed here too: WA and SMS no longer seed
// `Stage = member` on the first "Add filter" click. That default was kept in
// P1 only because those two surfaces were blind — an unset row would have
// WIDENED a send invisibly. With a live count plus the shared component's
// explicit "unfinished filter row is being ignored" warning, the widening
// failure is now stated out loud, while the silent narrowing the default
// caused was not. See the FILTER-B report for the full reasoning.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))

import WABroadcastEditor from '../WABroadcastEditor.jsx'
import SMSBroadcastEditor from '../SMSBroadcastEditor.jsx'
import SequenceSettings from '../sequences/SequenceSettings.jsx'

const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

let countCalls
beforeEach(() => {
  countCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/api/communications/audience-count')) {
      countCalls.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ success: true, count: 7, matched: 11, reachable: 7, excluded: {} }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [], segments: [] }) }
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WABroadcastEditor mounts the shared count (channel=whatsapp)', () => {
  it('counts with channel whatsapp, not the email-reachable number', async () => {
    const { findByText } = render(
      <WABroadcastEditor
        broadcast={{ id: 'b1', status: 'draft', name: 'x', audience_filter: FILTER }}
        templates={[]} locationId="loc-1" userId="u1"
      />,
    )
    await waitFor(() => expect(countCalls.length).toBeGreaterThan(0), { timeout: 2000 })
    expect(countCalls[0].channel).toBe('whatsapp')
    expect(countCalls[0].location_id).toBe('loc-1')
    await findByText(/reachable on WhatsApp/)
  })
})

describe('SMSBroadcastEditor mounts the shared count (channel=sms)', () => {
  it('counts with channel sms and shows the will-receive split', async () => {
    const { findByText } = render(
      <SMSBroadcastEditor
        broadcast={{ id: 'b1', status: 'draft', name: 'x', body: 'hi', audience_filter: FILTER }}
        recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1"
      />,
    )
    await waitFor(() => expect(countCalls.length).toBeGreaterThan(0), { timeout: 2000 })
    expect(countCalls[0].channel).toBe('sms')
    await findByText(/will receive it/)
  })
})

describe('SequenceSettings mounts a MATCHING count, never a send count (SEQEXIT.1)', () => {
  function openSettings() {
    const utils = render(<SequenceSettings sequence={{ id: 's1', name: 'Seq', location_id: 'loc-1', audience_filter: FILTER }} />)
    // The panel is behind a disclosure in the settings header.
    const toggle = utils.container.querySelector('button')
    if (toggle) fireEvent.click(toggle)
    return utils
  }

  it('asks channel-agnostically and labels the number a match', async () => {
    const { findByText, queryByText } = openSettings()
    await waitFor(() => expect(countCalls.length).toBeGreaterThan(0), { timeout: 2000 })
    expect(countCalls[0].channel).toBeUndefined()
    expect(countCalls[0].location_id).toBe('loc-1')
    await findByText(/currently match this audience/i)
    expect(queryByText(/will receive it/i)).toBeNull()
  })
})

// ── FILTER-FOUND row 1 — the re-decision ────────────────────────────
describe('WA and SMS no longer seed Stage = member on "Add filter"', () => {
  it.each([
    ['WhatsApp', () => render(
      <WABroadcastEditor broadcast={{ id: 'b1', status: 'draft', name: 'x', audience_filter: { logic: 'and', filters: [] } }}
        templates={[]} locationId="loc-1" userId="u1" />,
    )],
    ['SMS', () => render(
      <SMSBroadcastEditor broadcast={{ id: 'b1', status: 'draft', name: 'x', body: 'hi', audience_filter: { logic: 'and', filters: [] } }}
        recipients={[]} locationId="loc-1" locationSenderId="s1" userId="u1" />,
    )],
  ])('%s: the new row starts unset and is called out as unfinished', async (_label, mount) => {
    const { container, getByText, findByText } = mount()
    fireEvent.click(getByText('Add filter'))
    const fieldSelects = Array.from(container.querySelectorAll('select'))
    // No row silently carrying the member stage.
    expect(fieldSelects.some(s => s.value === 'pipeline_stage_slug')).toBe(false)
    expect(container.textContent).toContain('Choose a field…')
    await findByText(/unfinished filter row is being ignored/i)
  })
})
