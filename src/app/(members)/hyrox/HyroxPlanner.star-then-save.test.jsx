// @vitest-environment jsdom
//
// C32 HYROXSTAR.1 — "Save as style example" appended to the STORED examples
// but never to the page's own list, and the house-style Save PUTs that list
// as a whole: starring a session and then saving the house style in the same
// page load silently deleted the starred example. The page now adds the
// returned example to its list and sends the ids it has seen, so the server
// keeps anything it never saw.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('focus=s1') }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))
vi.mock('@/components/HyroxBoard', () => ({ default: () => null }))

import HyroxPlanner from './HyroxPlanner.jsx'

const SESSION = {
  id: 's1', week_no: 2, slot: 1, status: 'draft', focus: 'Engine', is_benchmark: false,
  board: { stations: [] }, full_session: { main: '4 rounds: run, row, wall balls' },
}
const PASTED = { id: 'p1', source: 'pasted', label: 'Pasted one', text: 'PASTED' }
const STARRED = { id: 'session:s1', source: 'generated', label: 'Week 2 session 1 - Engine', text: 'STARRED' }

const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  globalThis.fetch = vi.fn((url) => {
    if (String(url).endsWith('/exemplar')) return json({ success: true, data: { added: true, example: STARRED } })
    if (String(url) === '/api/hyrox/settings') return json({ success: true, data: { hyrox: { style_examples: [STARRED, PASTED] } } })
    return json({ success: false }, 500)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('HyroxPlanner — star, then save the house style', () => {
  it('keeps the starred example: it shows in the list and the Save sends it with the ids seen', async () => {
    render(
      <HyroxPlanner
        initialBlock={null} initialSessions={[SESSION]} locationId="loc1" canManage
        initialSettings={{ charter: 'C', houseStyle: 'H', styleExamples: [PASTED] }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Save as style example/ }))
    await screen.findByText('Saved as example')
    expect(screen.getByText(STARRED.label)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/hyrox/settings', expect.anything()))
    const put = globalThis.fetch.mock.calls.find(([url]) => url === '/api/hyrox/settings')
    const body = JSON.parse(put[1].body)
    expect(body.style_examples.map((e) => e.id)).toEqual(['session:s1', 'p1'])
    expect(body.known_example_ids).toEqual(expect.arrayContaining(['session:s1', 'p1']))
  })

  it('a removed example is still sent as seen, so the server drops it', async () => {
    render(
      <HyroxPlanner
        initialBlock={null} initialSessions={[]} locationId="loc1" canManage
        initialSettings={{ charter: 'C', houseStyle: 'H', styleExamples: [PASTED] }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove example' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body)
    expect(body.style_examples).toEqual([])
    expect(body.known_example_ids).toEqual(['p1'])
  })
})
