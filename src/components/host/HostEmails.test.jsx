// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
let searchString = ''
const replace = vi.fn()
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(searchString), useRouter: () => ({ push: vi.fn(), replace }) }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); replace.mockClear() })

import HostEmailPreviewModal from './HostEmailPreviewModal.jsx'
import { PLATFORM_NAME } from '@/lib/brand-name'
import {
  buildTestSendBody, statsLine, rowSubline, schedulePanelDefaults, audienceSummary, sendConfirmCopy, rowActions,
  designStateForDraft,
} from './HostEmails.jsx'
import HostEmails from './HostEmails.jsx'

// HOST-EMAIL.10 — the Test button prompts for an address and posts it to
// /api/host/emails/[id]/send-test. Pure-function test only (the repo's host
// component convention, and jsdom cannot tell us anything useful about a
// prompt anyway): buildTestSendBody is the whole decision the click makes.
//
// A BLANK prompt must post {} rather than { to: '' }. The route treats a
// missing `to` as "use the host session's own email", but an empty string is
// a malformed address and 400s — so trimming to {} is what makes "just send
// it to me" work.

describe('buildTestSendBody', () => {
  it('posts the typed address', () => {
    expect(buildTestSendBody('richard@example.com')).toEqual({ to: 'richard@example.com' })
  })

  it('trims surrounding whitespace off a pasted address', () => {
    expect(buildTestSendBody('  richard@example.com  ')).toEqual({ to: 'richard@example.com' })
  })

  it('posts an empty body when the prompt is left blank, so the server uses the host email', () => {
    expect(buildTestSendBody('')).toEqual({})
  })

  it('treats a whitespace-only prompt as blank', () => {
    expect(buildTestSendBody('   ')).toEqual({})
  })

  it('treats a null prompt (cancelled dialog) as blank rather than throwing', () => {
    expect(buildTestSendBody(null)).toEqual({})
  })
})

describe('statsLine', () => {
  it('joins the headline stats for the list-row subline', () => {
    expect(statsLine({ sent: 124, delivered: 118, opened: 41, clicked: 9 })).toBe('124 sent · 118 delivered · 41 opened · 9 clicked')
  })

  it('returns null when there are no stats yet (old rows)', () => {
    expect(statsLine(undefined)).toBe(null)
  })
})

// HOST-SCHEDULE.1 — the list row's subline is one pure decision over the
// campaign row, and the schedule panel opens either on the row's own time
// (Change time) or on the next quarter hour (a fresh schedule).
describe('rowSubline', () => {
  it('a plain draft', () => {
    expect(rowSubline({ status: 'draft' })).toBe('Not sent yet')
  })
  it('a draft the sweeper refused reads the reason in plain words', () => {
    expect(rowSubline({ status: 'draft', schedule_error: 'daily_cap' })).toBe('Not sent. Daily send limit was reached. Schedule it again or send it now.')
  })
  it('a scheduled row shows the Dublin time', () => {
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-09-09T08:00:00.000Z' })).toBe('Scheduled for Wed 9 Sep, 09:00')
  })
  it('a sent row with stats keeps the stats line', () => {
    expect(rowSubline({ status: 'sent', stats: { sent: 124, delivered: 118, opened: 41, clicked: 9 } })).toBe('124 sent · 118 delivered · 41 opened · 9 clicked')
  })
  it('a sent row without stats falls back to the coarse count', () => {
    expect(rowSubline({ status: 'sent', sent_count: 120, recipient_count: 124 })).toBe('120/124 sent')
  })
})

describe('schedulePanelDefaults', () => {
  it('prefills a scheduled row with its own time', () => {
    expect(schedulePanelDefaults({ scheduled_for: '2026-09-09T08:00:00.000Z' }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-09', time: '09:00' })
  })
  it('defaults a draft to the next quarter hour at least 15 minutes out', () => {
    expect(schedulePanelDefaults({ scheduled_for: null }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
  it('falls back to the next quarter hour when scheduled_for is garbage', () => {
    expect(schedulePanelDefaults({ scheduled_for: 'nope' }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
})

describe('rowSubline — paused (HOST-EMAILS.2)', () => {
  it('a sending row with a paused_reason says why and who to ask', () => {
    expect(rowSubline({ status: 'sending', paused_reason: 'no_stream' }, undefined, 'Gym A')).toBe('Paused. Marketing sending is not set up yet. Ask Gym A.')
  })
  it('with no brand it floors on the platform name, never a literal gym', () => {
    expect(rowSubline({ status: 'sending', paused_reason: 'no_stream' })).toBe(`Paused. Marketing sending is not set up yet. Ask ${PLATFORM_NAME}.`)
  })
  it('a sending row without a reason keeps the stats line fallback', () => {
    expect(rowSubline({ status: 'sending', sent_count: 3, recipient_count: 10 })).toBe('3/10 sent')
  })
})

describe('audienceSummary', () => {
  const byId = new Map([['p1', { id: 'p1', subject: 'Race week' }]])
  it('names the parent for a reminder draft', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'p1' }, byId)).toBe("People who didn't open 'Race week'")
  })
  it('falls back when the parent is gone', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'zz' }, byId)).toBe("People who didn't open the original email")
  })
  it('is empty for ordinary audiences (the select shows those)', () => {
    expect(audienceSummary({ audience_kind: 'all' }, byId)).toBe('')
  })
})

describe('rowActions', () => {
  it('a sending row offers neither action', () => {
    expect(rowActions('sending')).toEqual({ duplicate: false, delete: false })
  })
  it('a draft offers both', () => {
    expect(rowActions('draft')).toEqual({ duplicate: true, delete: true })
  })
  it('a scheduled row offers both', () => {
    expect(rowActions('scheduled')).toEqual({ duplicate: true, delete: true })
  })
  it('a sent row offers duplicate only', () => {
    expect(rowActions('sent')).toEqual({ duplicate: true, delete: false })
  })
  it('a failed row offers duplicate only', () => {
    expect(rowActions('failed')).toEqual({ duplicate: true, delete: false })
  })
  it('an unknown status offers duplicate only (falls into the default branch)', () => {
    expect(rowActions('bogus')).toEqual({ duplicate: true, delete: false })
  })
})

describe('sendConfirmCopy', () => {
  it('reminder drafts confirm against the parent subject', () => {
    expect(sendConfirmCopy({ audience_kind: 'non_openers', audience_campaign_id: 'p1', email_type: 'marketing' }, 'attendees', new Map([['p1', { subject: 'Race week' }]])))
      .toBe("Send this email to people who didn't open 'Race week'?")
  })
  it('ordinary drafts keep the audience label and the utility note', () => {
    expect(sendConfirmCopy({ audience_kind: 'all', email_type: 'utility' }, 'all 10 contacts (where emailable)', new Map()))
      .toBe('Send this email to all 10 contacts (where emailable) as a UTILITY email (reaches attendees regardless of marketing opt-in)?')
  })
})

// HOST-EMAILS.2 — opening a draft is a design-state decision, and the bug
// worth a test is the CROSS-DRAFT LEAK: designed draft A parks its design in
// pendingDesignRef while the Unlayer script loads; text-only draft B is
// opened next; the script arrives and A's design loads into B, and saving B
// writes A's design onto it. The text branch must therefore clear the
// pending design, not merely switch mode.
describe('designStateForDraft', () => {
  const designed = { id: 'a', design_json: { body: { rows: [{ id: 'r1' }] } } }
  const textOnly = { id: 'b', design_json: null, body_html: '<p>hi</p>' }

  it('a designed draft with the editor already up loads the design straight in', () => {
    expect(designStateForDraft(designed, { editorInited: true, unlayerReady: true }))
      .toEqual({ mode: 'design', pendingDesign: null, notice: '', hasDesign: true, loadNow: true })
  })

  it('a designed draft opened before the editor is up parks the design and says it is loading', () => {
    expect(designStateForDraft(designed, { editorInited: false, unlayerReady: false }))
      .toEqual({ mode: 'design', pendingDesign: designed.design_json, notice: 'loading', hasDesign: true, loadNow: false })
  })

  it('keeps the failed notice when the script has already given up, rather than claiming it is loading', () => {
    expect(designStateForDraft(designed, { editorInited: false, unlayerReady: false, previousNotice: 'failed' }))
      .toEqual({ mode: 'design', pendingDesign: designed.design_json, notice: 'failed', hasDesign: true, loadNow: false })
  })

  it('a text-only draft opened after a designed one clears the pending design (no cross-draft leak)', () => {
    // The designed draft parked its design first...
    const parked = designStateForDraft(designed, { editorInited: false, unlayerReady: false })
    expect(parked.pendingDesign).toBe(designed.design_json)
    // ...and opening the text-only draft must drop it, not carry it over.
    expect(designStateForDraft(textOnly, { editorInited: false, unlayerReady: false, previousNotice: parked.notice }))
      .toEqual({ mode: 'text', pendingDesign: null, notice: '', hasDesign: false, loadNow: false })
  })

  it('a text-only draft with the editor up still carries no design (the canvas gets blanked)', () => {
    expect(designStateForDraft(textOnly, { editorInited: true, unlayerReady: true }))
      .toEqual({ mode: 'text', pendingDesign: null, notice: '', hasDesign: false, loadNow: false })
  })

  it('a missing draft is treated as text-only rather than throwing', () => {
    expect(designStateForDraft(null).mode).toBe('text')
  })
})

// HOST-EMAILS.2 — the preview dialog, rendered to static markup (this repo
// runs vitest under node with no jsdom, so the effects that add Escape /
// focus / scroll-lock are not exercised here; the markup contract is).
describe('HostEmailPreviewModal', () => {
  const render = (width) => renderToStaticMarkup(
    <HostEmailPreviewModal html="<p>hello</p>" width={width} onWidth={() => {}} onClose={() => {}} />,
  )

  it('is a modal dialog', () => {
    const html = render(375)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })

  it('renders the preview in a fully sandboxed iframe so nothing in the design can run', () => {
    const html = render(375)
    expect(html).toMatch(/<iframe[^>]*sandbox=""/)
    expect(html).toContain('&lt;p&gt;hello&lt;/p&gt;') // srcDoc, escaped into the attribute
  })

  it('marks the active width with aria-pressed', () => {
    expect(render(375)).toMatch(/aria-pressed="true"[^>]*>Mobile/)
    expect(render(700)).toMatch(/aria-pressed="true"[^>]*>Desktop/)
  })
})

// TZ.9 — the composer runs on the host's own clock (its anchor studio's zone);
// with no zone it is Europe/Dublin, as above.
describe('the host composer on a New York host', () => {
  const NY = 'America/New_York'
  it('a scheduled row shows New York time, in both halves of the year', () => {
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-09-09T13:00:00.000Z' }, NY)).toBe('Scheduled for Wed 9 Sep, 09:00')
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-11-04T14:00:00.000Z' }, NY)).toBe('Scheduled for Wed 4 Nov, 09:00')
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-11-04T14:00:00.000Z' }, 'Europe/Dublin'))
      .toBe(rowSubline({ status: 'scheduled', scheduled_for: '2026-11-04T14:00:00.000Z' }))
  })
  it('the panel opens on New York wall clock', () => {
    expect(schedulePanelDefaults({ scheduled_for: '2026-11-04T14:00:00.000Z' }, Date.parse('2026-11-01T10:03:00Z'), NY)).toEqual({ date: '2026-11-04', time: '09:00' })
    // 2026-11-01T03:50Z is 23:50 EDT on 31 Oct; +17 min rounds up to 00:15 EDT on 1 Nov.
    expect(schedulePanelDefaults({ scheduled_for: null }, Date.parse('2026-11-01T03:50:00Z'), NY)).toEqual({ date: '2026-11-01', time: '00:15' })
  })
})

// HOSTPORTAL.4 — the Promote tab's "Write an email about this event" lands here
// with ?open=<draft id>&notice=event.
describe('HostEmails ?open and ?notice=event', () => {
  const DRAFT = 'd0000000-0000-4000-8000-0000000000d1'
  const EVENT_NOTICE = 'Draft created from your event. The short codes in angle brackets keep the layout and the booking link working: change the words between them, then press Preview as sent to see the email as it will arrive.'

  function stubApi({ list = [{ id: DRAFT, subject: 'Summer Run', status: 'draft', audience_kind: 'all', email_type: 'marketing' }] } = {}) {
    const calls = []
    const fetchMock = vi.fn(async (url) => {
      calls.push(String(url))
      const u = String(url)
      if (u === '/api/host/emails') return { ok: true, json: async () => ({ success: true, data: list }) }
      if (u === '/api/host/emails/audiences') return { ok: true, json: async () => ({ success: true, data: { all_count: 5, mailing_list_count: 0, events: [] } }) }
      if (u.startsWith('/api/host/emails/')) {
        const id = u.split('/').pop()
        return { ok: true, json: async () => ({ success: true, data: { id, subject: 'Summer Run', body_html: '<p>Hello</p>', design_json: null, audience_kind: 'all', email_type: 'marketing', status: 'draft' } }) }
      }
      return { ok: true, json: async () => ({ success: true, data: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return calls
  }
  const opens = (calls) => calls.filter((u) => u === `/api/host/emails/${DRAFT}`)

  it('opens the draft named by ?open once the list has loaded, and only once', async () => {
    searchString = `open=${DRAFT}&notice=event`
    const calls = stubApi()
    const { rerender } = render(<HostEmails />)
    await waitFor(() => expect(opens(calls)).toHaveLength(1))
    // the list was read before the draft was opened
    expect(calls.indexOf('/api/host/emails')).toBeLessThan(calls.indexOf(`/api/host/emails/${DRAFT}`))
    await waitFor(() => expect(document.getElementById('host-email-subject').value).toBe('Summer Run'))
    // later re-renders (new search-params object) never open it again
    searchString = `open=${DRAFT}&notice=event&x=1`
    rerender(<HostEmails />)
    rerender(<HostEmails zone="America/New_York" />)
    await new Promise((r) => setTimeout(r, 30))
    expect(opens(calls)).toHaveLength(1)
  })

  it('does nothing for an id that is not one of this host\'s drafts', async () => {
    searchString = 'open=not-mine&notice=event'
    const calls = stubApi()
    render(<HostEmails />)
    await waitFor(() => expect(calls).toContain('/api/host/emails'))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.filter((u) => u.endsWith('/not-mine'))).toHaveLength(0)
  })

  it('does not open a draft that has already been sent', async () => {
    searchString = `open=${DRAFT}`
    const calls = stubApi({ list: [{ id: DRAFT, subject: 'Old', status: 'sent', audience_kind: 'all', email_type: 'marketing' }] })
    render(<HostEmails />)
    await waitFor(() => expect(calls).toContain('/api/host/emails'))
    await new Promise((r) => setTimeout(r, 30))
    expect(opens(calls)).toHaveLength(0)
  })

  it('shows the event-draft notice for ?notice=event, and keeps it after the draft opens', async () => {
    searchString = `open=${DRAFT}&notice=event`
    const calls = stubApi()
    render(<HostEmails />)
    await waitFor(() => expect(opens(calls)).toHaveLength(1))
    await waitFor(() => expect(screen.getByText(EVENT_NOTICE)).toBeTruthy())
  })

  it('shows the event-draft notice for ?notice=event even with no ?open', async () => {
    searchString = 'notice=event'
    stubApi()
    render(<HostEmails />)
    await waitFor(() => expect(screen.getByText(EVENT_NOTICE)).toBeTruthy())
  })

  it('cleans the URL once with router.replace after the draft is open, and the notice stays on screen', async () => {
    searchString = `open=${DRAFT}&notice=event`
    const calls = stubApi()
    const { rerender } = render(<HostEmails />)
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(replace).toHaveBeenCalledWith('/host/emails')
    expect(opens(calls)).toHaveLength(1)
    // the URL is now clean: the params are gone, and the notice is not cleared
    searchString = ''
    rerender(<HostEmails />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText(EVENT_NOTICE)).toBeTruthy()
    expect(document.getElementById('host-email-subject').value).toBe('Summer Run')
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('does not clean the URL before the list has loaded and the draft has opened', async () => {
    searchString = `open=${DRAFT}&notice=event`
    stubApi()
    render(<HostEmails />)
    expect(replace).not.toHaveBeenCalled()
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(document.getElementById('host-email-subject').value).toBe('Summer Run')
  })

  it('cleans the URL for ?notice=event with no ?open and for ?notice=reminder, keeping the notice', async () => {
    searchString = 'notice=event'
    stubApi()
    const { unmount } = render(<HostEmails />)
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(screen.getByText(EVENT_NOTICE)).toBeTruthy()
    unmount()
    replace.mockClear()
    searchString = 'notice=reminder'
    render(<HostEmails />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/host/emails'))
    expect(screen.getByText('Reminder draft created. Edit it, test it, then send or schedule.')).toBeTruthy()
  })

  it('cleans the URL when ?open names something that is not a draft of this host', async () => {
    searchString = 'open=not-mine'
    stubApi()
    render(<HostEmails />)
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
  })
})
