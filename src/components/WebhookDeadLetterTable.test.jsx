// @vitest-environment jsdom
//
// MAIL-DEADLETTER.1 — the Replay action's inline outcome.
//
// A replay is the one morgue action with THREE answers, and the middle one is
// the trap: the route answers 200 with `success:false, recorded:false` when the
// pipeline ran cleanly and filed nothing (mailbox still missing, no sender). The
// generic `act()` used to treat any `success:false` as a thrown error, which
// would have shown "action failed" for a run that did exactly what it should;
// and treating any 200 as success would have shown a green tick over a row that
// is still open. So the outcome is judged per answer, surfaced inline, and the
// row stays visible in the pending tab.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

import WebhookDeadLetterTable, { replayOutcome } from './WebhookDeadLetterTable.jsx'

const ROW = {
  id: 7, provider: 'postmark_inbound', event_type: 'inbound_email', status: 'pending',
  attempts: 1, error: 'no_matching_mailbox', received_at: new Date().toISOString(),
  replayable: true, payload: { MessageID: 'pm-1', From: 'member@example.com', Subject: 'Billing' },
}

describe('replayOutcome — one line per answer', () => {
  it('filed → ok tone, names the ticket, says resolved', () => {
    const out = replayOutcome(ROW, { success: true, status: 'resolved', recorded: true, result: { ticket_id: 'T-1' } })
    expect(out.tone).toBe('ok')
    expect(out.text).toContain('ticket T-1')
    expect(out.text).toContain('resolved')
  })

  it('already filed → ok tone, says nothing was replayed', () => {
    const out = replayOutcome(ROW, { success: true, status: 'resolved', recorded: true, result: { already_filed: true } })
    expect(out.tone).toBe('ok')
    expect(out.text).toMatch(/already filed/)
  })

  it('recorded nothing → WARN tone (never ok), carries the reason + its hint, says the row stays open', () => {
    const out = replayOutcome(ROW, { success: false, status: 'pending', recorded: false, reason: 'no_matching_mailbox' })
    expect(out.tone).toBe('warn')
    expect(out.text).toContain('no_matching_mailbox')
    expect(out.text).toMatch(/add the mailbox/)
    expect(out.text).toMatch(/stays open/)
  })

  it('an unknown reason still surfaces verbatim, without a hint', () => {
    const out = replayOutcome(ROW, { success: false, recorded: false, reason: 'something_new' })
    expect(out.tone).toBe('warn')
    expect(out.text).toContain('something_new')
  })

  it('a thrown re-driver → ERROR tone with the message, even though the route also says recorded:false', () => {
    // The route stamps recorded:false on every non-resolved answer, a thrown
    // re-driver included; only `error` separates a failure from a clean no-op.
    // Judged the other way round this rendered "ran but filed nothing (no_op)"
    // for a database outage.
    const out = replayOutcome(ROW, { success: false, status: 'pending', recorded: false, error: 'contact_lookup_failed' })
    expect(out.tone).toBe('error')
    expect(out.text).toContain('contact_lookup_failed')
    expect(out.text).toMatch(/stays open/)
  })
})

describe('<WebhookDeadLetterTable /> — Replay surfaces its answer inline', () => {
  let replayAnswer
  let calls

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      calls.push({ url: u, method: opts?.method || 'GET' })
      if (u.includes('/replay')) {
        return { ok: true, status: 200, json: async () => replayAnswer }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [ROW] }) }
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  async function clickReplay() {
    render(<WebhookDeadLetterTable />)
    const btn = await screen.findByRole('button', { name: /replay/i })
    fireEvent.click(btn)
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/7/replay') && c.method === 'POST')).toBe(true))
  }

  it('recorded:false (a 200) is NOT shown as an error and NOT as success — the warn notice says why and that the row stays open', async () => {
    replayAnswer = { success: false, status: 'pending', recorded: false, reason: 'no_matching_mailbox', id: 7, provider: 'postmark_inbound' }
    await clickReplay()
    const notice = await screen.findByText(/replay ran but filed nothing/i)
    expect(notice.textContent).toContain('no_matching_mailbox')
    expect(notice.textContent).toMatch(/stays open/)
    expect(notice.closest('div').className).toContain('text-amber-700')
    expect(screen.queryByText(/action failed/i)).toBeNull()
    expect(screen.queryByText(/row resolved/i)).toBeNull()
  })

  it('recorded:true shows the green resolved notice', async () => {
    replayAnswer = { success: true, status: 'resolved', recorded: true, result: { ticket_id: 'T-9' }, id: 7, provider: 'postmark_inbound' }
    await clickReplay()
    const notice = await screen.findByText(/replayed and filed on ticket T-9/i)
    expect(notice.closest('div').className).toContain('text-green-700')
  })

  it('a non-2xx replay answer takes the generic error path', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url)
      calls.push({ url: u, method: u.includes('/replay') ? 'POST' : 'GET' })
      if (u.includes('/replay')) return { ok: false, status: 400, json: async () => ({ success: false, error: 'provider not replayable' }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [ROW] }) }
    })
    await clickReplay()
    await screen.findByText(/provider not replayable/i)
  })
})
