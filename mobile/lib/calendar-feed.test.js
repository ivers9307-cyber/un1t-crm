// ICSFEED.1 — what the Schedule tab's calendar row says and does.
import { describe, it, expect } from 'vitest'
import { feedRowModel, lastSyncedLabel, subscribeOpenOrder, REPLACE_PROMPT, TURN_OFF_PROMPT } from './calendar-feed'

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

describe('subscribeOpenOrder — which link to hand the OS first', () => {
  it('iOS: webcal opens Apple Calendar\'s subscribe sheet', () => {
    expect(subscribeOpenOrder('ios', URLS)).toEqual([URLS.webcal_url])
  })
  it('Android: Google Calendar\'s add-by-URL page first (no app claims webcal by default)', () => {
    expect(subscribeOpenOrder('android', URLS)).toEqual([URLS.google_url, URLS.webcal_url])
  })
  it('anything else: webcal, then Google', () => {
    expect(subscribeOpenOrder('web', URLS)).toEqual([URLS.webcal_url, URLS.google_url])
  })
  it('never hands the OS anything but webcal:// or https:// (a bad response cannot open javascript:)', () => {
    expect(subscribeOpenOrder('ios', { webcal_url: 'javascript:alert(1)' })).toEqual([])
    expect(subscribeOpenOrder('android', { google_url: 'http://calendar.google.com/x', webcal_url: null })).toEqual([])
    expect(subscribeOpenOrder('ios', null)).toEqual([])
  })
})

describe('prompt copy', () => {
  it('says what a new link does to the old one, and what turning off does', () => {
    expect(REPLACE_PROMPT.body).toMatch(/stop updating/)
    expect(TURN_OFF_PROMPT.body).toMatch(/stop getting your shifts/)
  })
})
