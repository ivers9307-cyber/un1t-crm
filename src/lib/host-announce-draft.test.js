// HOSTPORTAL.4 — the body of "Write an email about this event".
import { describe, it, expect } from 'vitest'
import { announceDraft } from './host-announce-draft'
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
    expect(body_html).toContain('09:00')
    expect(body_html).toContain('Early wave')
    expect(body_html).toContain('10:30')
    expect(body_html).toContain('Phoenix Park')
    expect(body_html).toContain(`<a href="${URL_}">Book your place</a>`)
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
