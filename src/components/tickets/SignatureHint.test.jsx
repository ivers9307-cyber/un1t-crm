// @vitest-environment jsdom
//
// MAILFIX-SIGTRUTH.1 — the composers' hint tells the truth about what a send
// will append. The audit found it reading only the plain column: with the
// rich signature enabled and the plain box empty it HID while a full block
// still went out. These tests pin the fixed contract:
//
//   • VISIBLE whenever anything will be appended — rich-enabled with an
//     empty plain column included (the exact case the old hint hid)
//   • the text is the EFFECTIVE signature for `locationId` — studio name,
//     studio phone/links where the studio card defines them — for EVERY
//     permitted studio, mailbox or not (an orphan ticket still resolves)
//   • HIDDEN when nothing will be appended, and HIDDEN for a studio the
//     caller has no context for — never the person's unresolved values
//   • a photo-only block draws no "-- " separator (the send appends none)
//   • fetched per mount, and REFETCHED when another tab saves a signature
//     (`storage` event) or the tab comes back into view (throttled)
//   • the reply box hands it the ticket's own location (the send resolves
//     the studio half off ticket.location_id, so the hint must too)

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor } from '@testing-library/react'
import SignatureHint, { SIGNATURE_UPDATED_KEY, markSignatureUpdated } from './SignatureHint.jsx'
import TicketReplyBox from './TicketReplyBox.jsx'
import { resolveViewerId } from '@/components/mail/viewer-id'

// The reply box resolves the signed-in user for draft scoping; mocked so the
// integration case below runs without a supabase client.
vi.mock('@/components/mail/viewer-id', () => ({ resolveViewerId: vi.fn() }))

const BUCKET_PHOTO = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u/p.jpg'

const RICH = {
  enabled: true, name: 'Alex Example', title: 'Head Coach',
  phone: '087 111 2222', note: 'typed note', photo_url: null, links: [],
}

const CONTEXTS = [
  {
    location_id: 'loc-still',
    location_name: 'UN1T Stillorgan',
    studio_signature: { phone: '01 555 0001', links: [{ label: 'Book Stillorgan', url: 'https://un1t.ie/stillorgan' }] },
    has_mailbox: true,
  },
  // Permitted, NO mailbox — the orphan-ticket studio. Still resolves.
  { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: false },
]

// A stub whose payload can CHANGE between reads (so a refetch can be seen to
// render new text), and which resolves `read` once the component has
// consumed the FIRST payload — an absence assertion anchors on that rather
// than on a guessed number of microtask ticks.
function stubPreferences(initial) {
  const state = { data: initial }
  let markRead
  const read = new Promise((resolve) => { markRead = resolve })
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/api/me/preferences')) {
      return Promise.resolve({
        json: () => {
          markRead()
          return Promise.resolve({
            success: true,
            data: {
              landing_preference: 'auto',
              email_signature: '',
              email_signature_rich: null,
              active_location_id: null,
              signature_contexts: CONTEXTS,
              ...state.data,
            },
          })
        },
      })
    }
    return new Promise(() => {})
  }))
  return { read, set: (next) => { state.data = next } }
}

async function settled(read) {
  expect(global.fetch).toHaveBeenCalled()
  await read
  await act(async () => {})
}

const prefsCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).includes('/api/me/preferences')).length

beforeEach(() => {
  resolveViewerId.mockResolvedValue('user-1')
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  // A test may have pinned visibilityState; drop the override.
  delete document.visibilityState
})

describe('SignatureHint — the effective signature, per sending location', () => {
  it('APPEARS with the rich signature enabled and the plain column EMPTY — the case the old hint hid', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-still" />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    const pre = document.querySelector('pre')
    // Studio-resolved for Stillorgan: its name on the note line, its phone
    // and link over the person's own.
    expect(pre.textContent).toContain('UN1T Stillorgan')
    expect(pre.textContent).toContain('01 555 0001')
    expect(pre.textContent).toContain('Book Stillorgan: https://un1t.ie/stillorgan')
    expect(pre.textContent).not.toContain('087 111 2222')
    expect(pre.textContent).not.toContain('typed note')
    // Plain text in the hint; the rich layout is named, not rendered.
    expect(screen.getByText(/carries the rich layout/i)).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })

  it('a PERMITTED, mailbox-less studio resolves — its name on the line, never the stored note', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-hatch" />)

    await screen.findByText(/added automatically/i)
    const pre = document.querySelector('pre')
    expect(pre.textContent).toContain('UN1T Hatch Street')
    expect(pre.textContent).toContain('087 111 2222') // Hatch has no card — person's phone stands
    expect(pre.textContent).not.toContain('01 555 0001')
    expect(pre.textContent).not.toContain('typed note')
  })

  it('HIDES for a location the caller has NO context for — never the unresolved values, never the plain column', async () => {
    const { read } = stubPreferences({ email_signature: 'Plain Sarah', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-elsewhere" />)
    await settled(read)
    expect(screen.queryByText(/added automatically/i)).toBeNull()
    expect(document.body.textContent).not.toContain('typed note')
    expect(document.body.textContent).not.toContain('Plain Sarah')
  })

  it('falls back to the plain column when the rich signature is off — todayʼs behaviour, untouched', async () => {
    stubPreferences({ email_signature: 'Sarah\nUN1T', email_signature_rich: { ...RICH, enabled: false } })
    render(<SignatureHint locationId="loc-still" />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    expect(document.querySelector('pre').textContent).toContain('Sarah\nUN1T')
    expect(screen.queryByText(/rich layout/i)).toBeNull()
  })

  it('HIDES when nothing will be appended — no signature anywhere, no stray "--"', async () => {
    const { read } = stubPreferences({ email_signature: '', email_signature_rich: null })
    render(<SignatureHint locationId="loc-still" />)
    // Anchor on the payload having been consumed, then flush React — an
    // absence asserted before the fetch settles would pass vacuously.
    await settled(read)
    expect(screen.queryByText(/added automatically/i)).toBeNull()
  })

  it('a PHOTO-ONLY block draws the label and suffix only — no "-- " block, and never a promise of links', async () => {
    const photoOnly = { enabled: true, name: '', title: '', phone: '', note: '', photo_url: BUCKET_PHOTO, links: [] }
    // A permitted studio with nothing to put on the studio line.
    stubPreferences({
      email_signature: '',
      email_signature_rich: photoOnly,
      signature_contexts: [{ location_id: 'loc-x', location_name: null, studio_signature: null, has_mailbox: true }],
    })
    render(<SignatureHint locationId="loc-x" />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    expect(screen.getByText(/rich layout — photo included\./i)).toBeTruthy()
    expect(screen.queryByText(/links included/i)).toBeNull()
    // The send appends no text part and no separator, so neither is drawn.
    expect(document.querySelector('pre')).toBeNull()
    expect(document.body.textContent).not.toContain('-- ')
  })
})

describe('SignatureHint — a mounted composer never goes stale', () => {
  it('fetches per mount — no memo: a second mount is a second GET', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-still" />)
    await screen.findByText(/added automatically/i)
    expect(prefsCalls()).toBe(1)
    cleanup()
    render(<SignatureHint locationId="loc-still" />)
    await screen.findByText(/added automatically/i)
    expect(prefsCalls()).toBe(2)
  })

  it('refetches when another tab saves a signature (storage event for the key) and renders the NEW text', async () => {
    const stub = stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-still" />)
    await screen.findByText(/added automatically/i)
    expect(document.querySelector('pre').textContent).toContain('Alex Example')
    expect(prefsCalls()).toBe(1)

    // The other tab saved a new name — its editor writes the key, and the
    // browser fires `storage` in THIS tab.
    stub.set({ email_signature: '', email_signature_rich: { ...RICH, name: 'Sarah Doyle' } })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SIGNATURE_UPDATED_KEY, newValue: '1' }))
    })
    await waitFor(() => expect(document.querySelector('pre').textContent).toContain('Sarah Doyle'))
    expect(document.querySelector('pre').textContent).not.toContain('Alex Example')
    expect(prefsCalls()).toBe(2)
  })

  it('ignores storage events for other keys', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-still" />)
    await screen.findByText(/added automatically/i)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'un1t.something-else', newValue: '1' }))
    })
    await act(async () => {})
    expect(prefsCalls()).toBe(1)
  })

  it('refetches when the tab comes back into view — once per 5s, and never while hidden', async () => {
    const stub = stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<SignatureHint locationId="loc-still" />)
    await screen.findByText(/added automatically/i)
    expect(prefsCalls()).toBe(1)

    // Back into view: the first return always refreshes — the mount fetch
    // does not count against the throttle.
    stub.set({ email_signature: '', email_signature_rich: { ...RICH, name: 'Sarah Doyle' } })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(document.querySelector('pre').textContent).toContain('Sarah Doyle'))
    expect(prefsCalls()).toBe(2)

    // A flurry of tab switches inside the window is one read.
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {})
    expect(prefsCalls()).toBe(2)

    // Going HIDDEN is not a return.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {})
    expect(prefsCalls()).toBe(2)
  })

  it('markSignatureUpdated writes the key (and survives storage being unavailable)', () => {
    markSignatureUpdated()
    expect(window.localStorage.getItem(SIGNATURE_UPDATED_KEY)).toMatch(/^\d+$/)
    const setItem = window.localStorage.setItem
    window.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
    try {
      expect(() => markSignatureUpdated()).not.toThrow()
    } finally {
      window.localStorage.setItem = setItem
    }
  })
})

describe('TicketReplyBox hands the hint the ticket’s own location', () => {
  it('a reply on a MAILBOX-LESS orphan ticket at a permitted studio resolves that studio — never the stored note', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(
      <TicketReplyBox
        ticket={{
          id: 'ticket-1', subject: 'Freeze', requester_email: 'a@x.com',
          // Orphan: no mailbox (ON DELETE SET NULL), at Hatch — which runs
          // no mailbox at all. The send still resolves Hatch; so must this.
          status: 'open', mailbox_id: null, location_id: 'loc-hatch',
        }}
        replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false, empty: false }}
        onSend={vi.fn()}
        onRemoveRecipient={vi.fn()}
        onRestoreRecipient={vi.fn()}
      />
    )

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    const pre = screen.getByText(/UN1T Hatch Street/, { selector: 'pre' })
    expect(pre.textContent).toContain('087 111 2222') // Hatch has no card — person's phone stands
    expect(pre.textContent).not.toContain('01 555 0001')
    expect(pre.textContent).not.toContain('typed note')
  })
})
