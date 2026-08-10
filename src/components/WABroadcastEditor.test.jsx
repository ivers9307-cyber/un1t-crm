// @vitest-environment jsdom
//
// COMMS-DETAIL-FIX.1 / .3 — the WhatsApp send-detail body.
//
//  .1  The four stat cards read broadcast.total_*, while the failed-sends box
//      immediately below them counted recipient rows live. On the 30 Jun
//      broadcast that rendered "FAILED 0" directly above "Failed sends (22)".
//      Both now read the SAME display object, so the two can no longer
//      disagree by construction.
//
//  .3  The body kept an inner max-w-2xl (drip) / max-w-3xl (terminal) inside
//      CommsShell's content column, so the shared header rule did not line up
//      with the panels under it AND the page changed width the moment a drip
//      finished. Email and SMS both fill the column; WhatsApp now does too.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

import WABroadcastEditor from './WABroadcastEditor.jsx'

beforeEach(() => {
  cleanup()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SENT = {
  id: 'b1',
  name: 'WhatsApp — 30 Jun',
  status: 'sent',
  delivery_mode: 'bulk',
  // Deliberately stale, exactly as measured live.
  total_recipients: 12, total_sent: 12, total_delivered: 12, total_read: 12, total_failed: 0,
  whatsapp_broadcast_recipients: [],
}

// What the page now hands down: counted from whatsapp_broadcast_recipients.
const LIVE = {
  source: 'recipients',
  audience: 12, queued: 12, neverQueued: 0, stoppedShort: false,
  sent: 12, delivered: 2, read: 0, failed: 22,
}

// The headline number on the results card with this label.
function statCard(label) {
  return screen.getByText(label, { selector: 'p' }).nextElementSibling.textContent
}

describe('WABroadcastEditor — the cards cannot contradict the failure list', () => {
  it('shows the LIVE failed count on the Failed card, not the stored zero', () => {
    render(
      <WABroadcastEditor
        broadcast={SENT} templates={[]} locationId="loc-1" userId="u1"
        stats={LIVE}
        failedRecipients={[{ id: 'r1', error_message: 'Bad number', contacts: { name: 'Ann', phone: '+353871111111' } }]}
      />
    )
    expect(statCard('Failed')).toBe('22')
    expect(screen.getByText(/Failed sends \(22\)/)).toBeTruthy()
  })

  it('shows the LIVE delivered count, not the stored counter', () => {
    render(<WABroadcastEditor broadcast={SENT} templates={[]} locationId="loc-1" userId="u1" stats={LIVE} failedRecipients={[]} />)
    expect(statCard('Delivered')).toBe('2')
  })

  it('says out loud when the figures came from the stale counters instead', () => {
    render(
      <WABroadcastEditor
        broadcast={SENT} templates={[]} locationId="loc-1" userId="u1"
        stats={{ ...LIVE, source: 'counters' }} failedRecipients={[]}
      />
    )
    expect(screen.getByText(/stored counters/i)).toBeTruthy()
  })
})

describe('WABroadcastEditor — a cancelled broadcast states both figures', () => {
  const CANCELLED = { ...SENT, id: 'b2', status: 'cancelled', name: 'Consultation jun 28th', total_recipients: 3108 }
  const CANCELLED_STATS = {
    source: 'recipients',
    audience: 3108, queued: 1146, neverQueued: 1962, stoppedShort: true,
    sent: 976, delivered: 969, read: 400, failed: 170,
  }

  it('names the audience and the queued count separately, neither correcting the other', () => {
    render(<WABroadcastEditor broadcast={CANCELLED} templates={[]} locationId="loc-1" userId="u1" stats={CANCELLED_STATS} failedRecipients={[]} />)
    const note = screen.getByTestId('wa-cancelled-note').textContent
    expect(note).toMatch(/1,146/)
    expect(note).toMatch(/3,108/)
    expect(note).toMatch(/1,962/)
  })

  it('does not show the stopped-short note on a completed send', () => {
    render(<WABroadcastEditor broadcast={SENT} templates={[]} locationId="loc-1" userId="u1" stats={LIVE} failedRecipients={[]} />)
    expect(screen.queryByTestId('wa-cancelled-note')).toBeNull()
  })
})

describe('WABroadcastEditor — body width matches the other two channels (.3)', () => {
  it('does not cap the terminal results body inside the shell column', () => {
    const { container } = render(
      <WABroadcastEditor broadcast={SENT} templates={[]} locationId="loc-1" userId="u1" stats={LIVE} failedRecipients={[]} />
    )
    expect(container.querySelector('.max-w-3xl, .max-w-2xl')).toBeNull()
  })

  it('does not cap the in-flight drip body either, so finishing a drip cannot change the page width', () => {
    const { container } = render(
      <WABroadcastEditor
        broadcast={{ ...SENT, status: 'sending', delivery_mode: 'drip', send_window_start: '09:00:00', send_window_end: '20:00:00', send_window_tz: 'Europe/Dublin' }}
        templates={[]} locationId="loc-1" userId="u1"
        stats={LIVE}
        dripProgress={{ sentToday: 4, window: { state: 'sending' } }}
        failedRecipients={[]}
      />
    )
    expect(container.querySelector('.max-w-3xl, .max-w-2xl')).toBeNull()
  })
})
