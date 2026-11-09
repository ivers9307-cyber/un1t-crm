// HOSTPORTAL.4 — the body of "Write an email about this event".
import { describe, it, expect } from 'vitest'
import { announceDraft, announceBlockedReason } from './host-announce-draft'
import { tagHostCampaignLinks } from './host-campaign-links'
import { sanitizeCampaignHtml } from './host-campaign-email'

const URL_ = 'https://studio.test/event/summer-run'
const EVENT = { name: 'Summer Run', race_date: '2026-11-14', venue_name: 'Phoenix Park' }
const SESSIONS = [{ time: '09:00', label: 'Early wave' }, { time: '10:30', label: '' }]

describe('announceDraft', () => {
  it('uses the event name as the subject, cut to 200 characters', () => {
    expect(announceDraft({ event: EVENT, sessions: SESSIONS, eventUrl: URL_ }).subject).toBe('Summer Run')
    const long = announceDraft({ event: { ...EVENT, name: 'x'.repeat(250) }, sessions: [], eventUrl: URL_ }).subject
    expect(long).toHaveLength(200)
  })

  it('names the date in words, every session time, the venue and a Book your place link to the event URL', () => {
    const { body_html } = announceDraft({ event: EVENT, sessions: SESSIONS, eventUrl: URL_ })
    expect(body_html).toContain('Saturday 14 November 2026')
    expect(body_html).toContain('09:00 and 10:30')
    expect(body_html).toContain('Phoenix Park')
    expect(body_html).toContain(`<a href="${URL_}">Book your place</a>`)
  })

  it('is exactly three short paragraphs, one per line, with no inline tags besides the link', () => {
    const { body_html } = announceDraft({ event: EVENT, sessions: SESSIONS, eventUrl: URL_ })
    expect(body_html.split('\n')).toEqual([
      '<p>Summer Run</p>',
      '<p>Saturday 14 November 2026 · 09:00 and 10:30 · Phoenix Park</p>',
      `<p><a href="${URL_}">Book your place</a></p>`,
    ])
    expect(body_html).not.toContain('<strong')
  })

  it('joins session times as "a and b" for two and "a, b and c" for three or more, and drops labels', () => {
    const body = (times) => announceDraft({ event: EVENT, sessions: times.map((time) => ({ time, label: 'L' })), eventUrl: URL_ }).body_html
    expect(body(['10:00'])).toContain('November 2026 · 10:00 · Phoenix')
    expect(body(['10:00', '12:30'])).toContain('10:00 and 12:30')
    expect(body(['10:00', '12:30', '15:00'])).toContain('10:00, 12:30 and 15:00')
    expect(body(['10:00', '12:30', '15:00', '16:00'])).toContain('10:00, 12:30, 15:00 and 16:00')
    expect(body(['10:00'])).not.toContain('(L)')
  })

  it('omits a missing part of the middle line without stray separators, and the line itself when empty', () => {
    const mid = (event, sessions) => announceDraft({ event: { name: 'X', ...event }, sessions, eventUrl: URL_ }).body_html.split('\n')
    expect(mid({ race_date: '2026-11-14', venue_name: null }, [])[1]).toBe('<p>Saturday 14 November 2026</p>')
    expect(mid({ race_date: null, venue_name: 'Park' }, [{ time: '09:00' }])[1]).toBe('<p>09:00 · Park</p>')
    expect(mid({ race_date: null, venue_name: null }, [])).toHaveLength(2)
  })

  it('does not shift the date through a time zone', () => {
    const body = (d) => announceDraft({ event: { ...EVENT, race_date: d }, sessions: [], eventUrl: URL_ }).body_html
    expect(body('2026-01-01')).toContain('Thursday 1 January 2026')
    expect(body('2026-03-29')).toContain('Sunday 29 March 2026')
    expect(body('2026-12-31')).toContain('Thursday 31 December 2026')
  })

  it('leaves out the lines it has no facts for', () => {
    const { body_html } = announceDraft({ event: { name: 'Bare', race_date: null, venue_name: null }, sessions: [], eventUrl: URL_ })
    expect(body_html).toContain('Book your place')
    expect(body_html).not.toMatch(/undefined|null|Invalid/)
  })

  it('escapes the event name and venue', () => {
    const { body_html } = announceDraft({
      event: { ...EVENT, name: 'Run <script>alert(1)</script> & Co', venue_name: 'A & B <b>Park</b>' },
      sessions: [{ time: '09:00', label: '<img src=x>' }],
      eventUrl: URL_,
    })
    expect(body_html).not.toContain('<script>')
    expect(body_html).not.toContain('<b>')
    expect(body_html).not.toContain('<img')
    expect(body_html).toContain('Run &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co')
    expect(body_html).toContain('A &amp; B &lt;b&gt;Park&lt;/b&gt;')
  })

  it('survives the composer sanitizer unchanged and produces a link the campaign tagger tags with hc', () => {
    const { body_html } = announceDraft({ event: EVENT, sessions: SESSIONS, eventUrl: URL_ })
    expect(sanitizeCampaignHtml(body_html)).toBe(body_html)
    const tagged = tagHostCampaignLinks(body_html, { campaignId: 'c-123', tenantHost: 'studio.test' })
    expect(tagged).toContain('href="https://studio.test/event/summer-run?hc=c-123"')
    expect(tagged).not.toBe(body_html)
  })
})

describe('announceBlockedReason', () => {
  const OK = { status: 'published', active: true, race_date: '2026-11-14' }
  it('is null for a published, active event today or later', () => {
    expect(announceBlockedReason(OK, '2026-11-14')).toBeNull()
    expect(announceBlockedReason(OK, '2026-11-13')).toBeNull()
  })
  it('says the event has taken place once its date is before today, whatever its status', () => {
    const done = 'This event has already taken place.'
    expect(announceBlockedReason(OK, '2026-11-15')).toBe(done)
    expect(announceBlockedReason({ ...OK, status: 'draft' }, '2026-11-15')).toBe(done)
  })
  it('asks for a publish on a draft or rejected event', () => {
    for (const status of ['draft', 'rejected']) {
      expect(announceBlockedReason({ ...OK, status }, '2026-11-01')).toBe('Publish this event before emailing your list about it.')
    }
  })
  it('says it is waiting for approval when pending review', () => {
    expect(announceBlockedReason({ ...OK, status: 'pending_review' }, '2026-11-01'))
      .toBe('This event is waiting for approval. You can email your list once it is on sale.')
  })
  it('says it is off sale when published but not active', () => {
    expect(announceBlockedReason({ ...OK, active: false }, '2026-11-01'))
      .toBe('This event is off sale. Put it back on sale before emailing your list about it.')
  })
  it('falls back to the publish sentence for an unknown status', () => {
    expect(announceBlockedReason({ ...OK, status: 'weird' }, '2026-11-01')).toBe('Publish this event before emailing your list about it.')
  })
})
