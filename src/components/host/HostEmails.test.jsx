import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HostEmailPreviewModal from './HostEmailPreviewModal.jsx'
import {
  buildTestSendBody, statsLine, rowSubline, schedulePanelDefaults, audienceSummary, sendConfirmCopy, rowActions,
  designStateForDraft,
} from './HostEmails.jsx'

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
    expect(rowSubline({ status: 'sending', paused_reason: 'no_stream' })).toBe('Paused. Marketing sending is not set up yet. Ask UN1T.')
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
