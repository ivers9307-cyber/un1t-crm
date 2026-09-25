// ICSFEED.1 — what the Schedule tab's calendar row says and does.
import { describe, it, expect } from 'vitest'
import { feedRowModel, lastSyncedLabel, subscribeChoices, REPLACE_PROMPT, TURN_OFF_PROMPT, CHOOSE_PROMPT } from './calendar-feed'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const URLS = {
  url: 'https://crm.example.test/api/calendar-feed/rcf_x.ics',
  webcal_url: 'webcal://crm.example.test/api/calendar-feed/rcf_x.ics',
  google_url: 'https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fx',
}

describe('feedRowModel', () => {
  it('no link (or an unreadable status) offers to create one', () => {
    for (const s of [null, undefined, { active: false }]) {
      expect(feedRowModel(s, NOW)).toEqual({
        title: 'Subscribe to my shifts',
        subtitle: 'Add your published shifts to your calendar app.',
        action: 'create',
      })
    }
  })

  it('a live link says so, with when the calendar last checked', () => {
    expect(feedRowModel({ active: true, last_fetched_at: '2026-09-25T09:48:00Z' }, NOW)).toEqual({
      title: 'Calendar subscription on',
      subtitle: 'Your calendar last checked 12 min ago.',
      action: 'manage',
    })
  })

  it('a live link that has never been fetched says the calendar has not checked in', () => {
    expect(feedRowModel({ active: true, last_fetched_at: null }, NOW).subtitle)
      .toBe('Your calendar has not checked in yet.')
  })
})

describe('lastSyncedLabel', () => {
  it('reads a timestamp as a rough age', () => {
    expect(lastSyncedLabel('2026-09-25T09:59:40Z', NOW)).toBe('just now')
    expect(lastSyncedLabel('2026-09-25T09:48:00Z', NOW)).toBe('12 min ago')
    expect(lastSyncedLabel('2026-09-25T07:00:00Z', NOW)).toBe('3 h ago')
    expect(lastSyncedLabel('2026-09-22T10:00:00Z', NOW)).toBe('3 days ago')
  })
  it('garbage is null, and a clock-skewed future stamp is "just now"', () => {
    expect(lastSyncedLabel(null, NOW)).toBe(null)
    expect(lastSyncedLabel('nope', NOW)).toBe(null)
    expect(lastSyncedLabel('2026-09-25T10:05:00Z', NOW)).toBe('just now')
  })
})

describe('subscribeChoices — the coach picks where the one-time link goes', () => {
  const keys = (cs) => cs.map((c) => c.key)

  it('iOS: Apple Calendar (webcal), Google Calendar, and ALWAYS share/copy', () => {
    const cs = subscribeChoices('ios', URLS)
    expect(keys(cs)).toEqual(['apple', 'google', 'share'])
    expect(cs[0]).toEqual({ key: 'apple', label: 'Apple Calendar', kind: 'open', url: URLS.webcal_url })
    expect(cs[1]).toEqual({ key: 'google', label: 'Google Calendar', kind: 'open', url: URLS.google_url })
  })

  it('iOS Google Calendar users can get the https link: share hands over url, not webcal', () => {
    const share = subscribeChoices('ios', URLS).find((c) => c.key === 'share')
    expect(share).toEqual({ key: 'share', label: 'Share / copy link', kind: 'share', url: URLS.url })
  })

  it('Android: Google Calendar and share/copy only (an Alert holds three buttons with Cancel)', () => {
    expect(keys(subscribeChoices('android', URLS))).toEqual(['google', 'share'])
  })

  it('anything else: webcal, Google, share', () => {
    expect(keys(subscribeChoices('web', URLS))).toEqual(['calendar', 'google', 'share'])
  })

  it('share is ALWAYS offered when there is an https link, even if every open link is bad', () => {
    expect(keys(subscribeChoices('ios', { url: URLS.url, webcal_url: 'javascript:alert(1)', google_url: null })))
      .toEqual(['share'])
  })

  it('never hands the OS anything but webcal:// or https:// (a bad response cannot open javascript:)', () => {
    expect(subscribeChoices('ios', { webcal_url: 'javascript:alert(1)' })).toEqual([])
    expect(subscribeChoices('android', { url: 'http://crm.example.test/x.ics', google_url: 'http://calendar.google.com/x' })).toEqual([])
    expect(subscribeChoices('ios', null)).toEqual([])
  })
})

describe('the link held for this session', () => {
  it('while the new link is in hand, the row offers it again and says what to do if it is lost', () => {
    const m = feedRowModel({ active: true, last_fetched_at: null }, NOW, { linkInHand: true })
    expect(m.action).toBe('choose')
    expect(m.title).toBe('Add my shifts to a calendar')
    expect(m.subtitle).toMatch(/shown once/i)
    expect(m.subtitle).toMatch(/make a new/i)
  })

  it('without it, the row is back to manage / create', () => {
    expect(feedRowModel({ active: true }, NOW, { linkInHand: false }).action).toBe('manage')
    expect(feedRowModel(null, NOW).action).toBe('create')
  })

  it('the choice prompt says the link is shown once, and how to get it into Google on a computer', () => {
    expect(CHOOSE_PROMPT.body).toMatch(/shown once/i)
    expect(CHOOSE_PROMPT.body).toMatch(/make a new link/i)
    expect(CHOOSE_PROMPT.body).toMatch(/calendar\.google\.com/)
  })
})

describe('prompt copy', () => {
  it('says what a new link does to the old one, and what turning off does', () => {
    expect(REPLACE_PROMPT.body).toMatch(/stop updating/)
    expect(TURN_OFF_PROMPT.body).toMatch(/stop getting your shifts/)
  })
})
