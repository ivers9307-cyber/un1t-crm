// NOTE: split from UnifiedSendComposer.test.jsx during the #1310/#1314 rebase.
// Both PRs added a composer test file independently and their harnesses are
// deliberately different: this one renders the REAL AudienceBuilder (that is
// how the dangling "contacts match" footer is caught), while the sibling file
// mocks it out so it can drive the Unlayer loaded / export-failure states.
// Fusing them would have weakened both.

// @vitest-environment jsdom
//
// COMMSFIX.B.6 — the unified composer must surface audience-count errors and
// gate Send on a real count (2026-08-09 comms audit):
//   - a 400 from /api/communications/audience-count (e.g. the OR+tag
//     rejection) used to be swallowed into the "Add a condition…" placeholder
//     while Send stayed enabled — the campaign then wedged 'queued' forever
//     with zero feedback;
//   - canSend treated a null count as sendable;
//   - AudienceBuilder rendered a dangling "<undefined> contacts match" footer
//     because the audienceCount prop was omitted;
//   - the email panel now shows "N will receive it" with the B5 excluded
//     breakdown instead of a raw filter-only number.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}))
vi.mock('./useUnlayerEditor', () => ({
  useUnlayerEditor: () => ({ ref: { current: null }, loaded: true, exportHtml: vi.fn(async () => ({ html: '<p>x</p>', design: {} })) }),
}))
vi.mock('./ContactMultiSelect', () => ({
  default: () => <div data-testid="contact-multi-select" />,
}))

import UnifiedSendComposer from './UnifiedSendComposer.jsx'

// EVERY wait below crosses AudienceCount's 400ms DEBOUNCE (AudienceCount.jsx)
// before the stubbed fetch is even called, so none of them may rely on
// testing-library's 1000ms default. Measured idle cost is ~402ms — the default
// was never wrong by much, just too tight to survive a busy machine, and a
// loaded box eats the ~600ms of slack: the B6d test failed exactly that way in
// a full run that took 120s against a normal 50s, while passing alone and in a
// 50s run. Four of these ten tests were on the default when that happened.
//
// Keep this as the file's single knob. To check nothing has drifted back onto
// the default, add `configure({ asyncUtilTimeout: 50 })` after the imports and
// run the file: it must still pass.
const COUNTED = { timeout: 3000 }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubCount(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/communications/audience-count')) return handler()
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }))
}

function ok(body) { return { ok: true, status: 200, json: async () => ({ success: true, ...body }) } }
function bad(error, status = 400) { return { ok: false, status, json: async () => ({ success: false, error }) } }

const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

function sendButton() {
  // The schedule-mode pill is also named "Send now" — the primary CTA is the
  // last matching button on the page.
  return screen.getAllByRole('button', { name: /Send now|Schedule|Start drip/ }).at(-1)
}

describe('UnifiedSendComposer — count errors surface and gate Send (B6)', () => {
  it('renders the server error message from a 400 count, not the placeholder', async () => {
    stubCount(() => bad('OR logic is not supported together with tag, event or studio-list filters. Use AND, or send these as separate audiences.'))
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    await screen.findByText(/OR logic is not supported together with tag, event or studio-list filters/, {}, COUNTED)
    expect(screen.queryByText(/Add a condition to see how many contacts match/)).toBeNull()
  })

  it('keeps Send disabled while the count is in error, even with a valid message', async () => {
    stubCount(() => bad('tag filter requires a non-empty string value'))
    const { container } = render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    fireEvent.change(container.querySelector('textarea'), { target: { value: 'Hello there' } })
    await screen.findByText(/tag filter requires a non-empty string value/, {}, COUNTED)
    expect(sendButton().disabled).toBe(true)
  })

  it('keeps Send disabled while the count has not arrived yet', () => {
    stubCount(() => new Promise(() => {})) // never resolves
    const { container } = render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    fireEvent.change(container.querySelector('textarea'), { target: { value: 'Hello there' } })
    expect(sendButton().disabled).toBe(true)
  })

  it('enables Send once a positive count arrives and the message is valid', async () => {
    stubCount(() => ok({ count: 5, matched: 9, excluded: { no_phone: 2, not_opted_in: 1, opted_out: 1 } }))
    const { container } = render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    fireEvent.change(container.querySelector('textarea'), { target: { value: 'Hello there' } })
    await waitFor(() => expect(sendButton().disabled).toBe(false), COUNTED)
  })

  it('does not render the dangling AudienceBuilder "contacts match" footer', () => {
    stubCount(() => new Promise(() => {}))
    const { container } = render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    const dangling = Array.from(container.querySelectorAll('span'))
      .some(s => s.textContent.trim() === 'contacts match')
    expect(dangling).toBe(false)
  })
})

describe('UnifiedSendComposer — email will-receive breakdown (B6d)', () => {
  it('shows matched vs will-receive and the excluded reasons', async () => {
    stubCount(() => ok({
      count: 2300, matched: 4900, suppressed: 300,
      excluded: { not_opted_in: 1200, bounced_or_complained: 24, suppressed: 300 },
    }))
    render(<UnifiedSendComposer locationId="loc-1" channels={['email']} initialAudienceFilter={FILTER} />)
    await screen.findByText(/will receive it/, {}, COUNTED)
    expect(screen.getByText('4,900')).toBeTruthy()
    expect(screen.getByText('2,300')).toBeTruthy()
    // Breakdown line carries the reasons from the B5 response.
    await screen.findByText(/1,200 no marketing opt-in/, {}, COUNTED)
    screen.getByText(/24 bounced or complained/)
    screen.getByText(/300 suppressed for repeat bounces/)
  })
})

// ── FILTER-P1.6c — "no match" and "no reach" are different problems ──
//
// The composer rendered "No contacts match this filter." whenever count === 0,
// but `count` is the ELIGIBLE number, not the match count — so it could
// contradict the "N match this filter · 0 will receive it" line directly above
// it. The second case is both the more common cause and the more actionable
// message, and the two need different fixes (widen the filter vs. look at
// consent/bounces/suppression).
describe('UnifiedSendComposer — zero-count message tells the truth (P1.6c)', () => {
  it('says nobody MATCHED when the filter itself returns nothing', async () => {
    stubCount(() => ok({ count: 0, matched: 0, excluded: {} }))
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    await screen.findByText(/No contacts match this filter/i, {}, COUNTED)
  })

  it('does NOT say "no contacts match" when contacts matched but none are reachable', async () => {
    stubCount(() => ok({ count: 0, matched: 240, excluded: { no_phone: 240 } }))
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    await waitFor(() => expect(screen.queryByText(/0 will receive it|will receive it/i)).not.toBeNull(), COUNTED)
    expect(screen.queryByText(/^No contacts match this filter\.$/i)).toBeNull()
  })

  it('names the matched count and points at reachability instead', async () => {
    stubCount(() => ok({ count: 0, matched: 240, excluded: { no_phone: 240 } }))
    render(<UnifiedSendComposer locationId="loc-1" channels={['sms']} initialAudienceFilter={FILTER} />)
    const msg = await screen.findByText(/none (of them )?can be reached|but none/i, {}, COUNTED)
    expect(msg.textContent).toMatch(/240/)
  })

  it('keeps the WhatsApp warning keyed on REACHABLE, not raw matches', async () => {
    stubCount(() => ok({ count: 300, matched: 300, reachable: 0 }))
    render(<UnifiedSendComposer locationId="loc-1" channels={['whatsapp']} initialAudienceFilter={FILTER} />)
    const msg = await screen.findByText(/but none/i, {}, COUNTED)
    expect(msg.textContent).toMatch(/300/)
  })
})
