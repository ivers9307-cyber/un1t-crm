import { describe, it, expect } from 'vitest'
import {
  CHARITY_DEFAULTS,
  CharitySettingsSchema,
  resolveCharitySettings,
  renderCharityCopy,
  computeCharityTotals,
  donationPublicState,
  formatCents,
  showsDonationsLink,
} from './charity-donations'

describe('computeCharityTotals (CHARITY.2)', () => {
  const donations = [
    { amount_cents: 2500, match_multiplier: 2, status: 'paid' },
    { amount_cents: 1000, match_multiplier: 1, status: 'paid' },
    { amount_cents: 9900, match_multiplier: 2, status: 'refunded' },
    { amount_cents: 500, match_multiplier: 1, status: 'awaiting_payment' },
  ]
  const entries = [
    { amount_cents: 4000, status: 'completed' },
    { amount_cents: 4000, status: 'pending' },
  ]

  it('counts only paid donations, matched per row; refunded excluded', () => {
    const t = computeCharityTotals({ donations, entries: [], multiplier: 1, includeEntries: false })
    expect(t.donations_cents).toBe(3500)
    expect(t.donations_matched_cents).toBe(2500 * 2 + 1000)
    expect(t.donation_count).toBe(2)
    expect(t.raised_cents).toBe(6000)
  })
  it('counts completed entries only and includes them in raised when asked', () => {
    const on = computeCharityTotals({ donations: [], entries, multiplier: 2, includeEntries: true })
    expect(on.entries_cents).toBe(4000)
    expect(on.entries_matched_cents).toBe(8000)
    expect(on.raised_cents).toBe(8000)
    const off = computeCharityTotals({ donations: [], entries, multiplier: 2, includeEntries: false })
    expect(off.entries_matched_cents).toBe(8000)
    expect(off.raised_cents).toBe(0)
  })
  it('rounds matched amounts and coerces string multipliers', () => {
    const t = computeCharityTotals({
      donations: [{ amount_cents: 333, match_multiplier: '1.5', status: 'paid' }],
      entries: [{ amount_cents: 333, status: 'completed' }],
      multiplier: 1.5,
      includeEntries: true,
    })
    expect(t.donations_matched_cents).toBe(500)
    expect(t.entries_matched_cents).toBe(500)
  })
  it('empty or missing inputs give zeros', () => {
    const zero = { donations_cents: 0, donations_matched_cents: 0, entries_cents: 0, entries_matched_cents: 0, raised_cents: 0, donation_count: 0 }
    expect(computeCharityTotals({ donations: [], entries: [], multiplier: 1, includeEntries: true })).toEqual(zero)
    expect(computeCharityTotals({})).toEqual(zero)
  })
})

describe('resolveCharitySettings', () => {
  it('a row with charity null gets the defaults and is disabled', () => {
    const s = resolveCharitySettings({ charity: null, charity_enabled: false })
    expect(s).toEqual({ ...CHARITY_DEFAULTS, enabled: false })
    expect(resolveCharitySettings(null).enabled).toBe(false)
  })
  it('saved keys override, null/undefined fall back, empty strings are kept', () => {
    const s = resolveCharitySettings({
      charity_enabled: true,
      charity: { name: 'MS Ireland', heading: null, blurb: '', min_cents: undefined, match_multiplier: '2.0' },
    })
    expect(s.enabled).toBe(true)
    expect(s.name).toBe('MS Ireland')
    expect(s.heading).toBe(CHARITY_DEFAULTS.heading)
    expect(s.blurb).toBe('')
    expect(s.min_cents).toBe(CHARITY_DEFAULTS.min_cents)
    expect(s.match_multiplier).toBe(2)
  })
  it('defaults are frozen', () => {
    expect(Object.isFrozen(CHARITY_DEFAULTS)).toBe(true)
  })
})

describe('CharitySettingsSchema', () => {
  it('accepts the defaults', () => {
    expect(CharitySettingsSchema.safeParse(CHARITY_DEFAULTS).success).toBe(true)
    expect(CharitySettingsSchema.safeParse({}).success).toBe(true)
  })
  it('rejects min_cents > max_cents', () => {
    expect(CharitySettingsSchema.safeParse({ min_cents: 1000, max_cents: 500 }).success).toBe(false)
  })
  it('rejects no presets with custom_allowed false', () => {
    expect(CharitySettingsSchema.safeParse({ presets_cents: [], custom_allowed: false }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [], custom_allowed: true }).success).toBe(true)
  })
  it('bounds the multiplier, presets and goal', () => {
    expect(CharitySettingsSchema.safeParse({ match_multiplier: 0.5 }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ match_multiplier: 6 }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [1, 2, 3, 4, 5, 6, 7, 8, 9] }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ goal_cents: null }).success).toBe(true)
    expect(CharitySettingsSchema.safeParse({ goal_cents: 0 }).success).toBe(false)
  })
  it('requires every preset to sit within [min, max] when custom amounts are allowed', () => {
    expect(CharitySettingsSchema.safeParse({ presets_cents: [1000, 600000], custom_allowed: true }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [1000, 5000], max_cents: 4000 }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [100], min_cents: 500 }).success).toBe(false)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [1000, 5000], max_cents: 5000 }).success).toBe(true)
    expect(CharitySettingsSchema.safeParse({ presets_cents: [1000, 600000], custom_allowed: false }).success).toBe(true)
  })
})

describe('renderCharityCopy', () => {
  it('replaces known tags', () => {
    expect(renderCharityCopy('Your {{amount}} to {{charity}}', { amount: '€25.00', charity: 'MS Ireland' })).toBe('Your €25.00 to MS Ireland')
  })
  it('leaves unknown tags and missing vars as is', () => {
    expect(renderCharityCopy('{{foo}} {{brand}}', { charity: 'x' })).toBe('{{foo}} {{brand}}')
    expect(renderCharityCopy(null, {})).toBe('')
  })
})

describe('donationPublicState', () => {
  it('maps statuses', () => {
    expect(donationPublicState(null)).toBe('notfound')
    expect(donationPublicState({ status: 'awaiting_payment' })).toBe('pending')
    expect(donationPublicState({ status: 'paid' })).toBe('paid')
    expect(donationPublicState({ status: 'failed' })).toBe('failed')
    expect(donationPublicState({ status: 'expired' })).toBe('failed')
    expect(donationPublicState({ status: 'refunded' })).toBe('refunded')
  })
})

describe('formatCents', () => {
  it('formats euro amounts', () => {
    expect(formatCents(2500, 'EUR')).toBe('€25.00')
    expect(formatCents(0, 'EUR')).toBe('€0.00')
  })
})

describe('showsDonationsLink (spec §6)', () => {
  it('shows when the section is on, or when any donation exists for the event', () => {
    const withDonations = new Set(['e2'])
    expect(showsDonationsLink({ id: 'e1', charity_enabled: true }, withDonations)).toBe(true)
    expect(showsDonationsLink({ id: 'e2', charity_enabled: false }, withDonations)).toBe(true)
    expect(showsDonationsLink({ id: 'e3', charity_enabled: false }, withDonations)).toBe(false)
  })
  it('a missing set means none', () => {
    expect(showsDonationsLink({ id: 'e1', charity_enabled: false })).toBe(false)
    expect(showsDonationsLink({ id: 'e1', charity_enabled: true })).toBe(true)
  })
})

describe('video_url (CHARITY.13)', () => {
  it('defaults to blank and accepts a YouTube or Instagram link', () => {
    expect(CHARITY_DEFAULTS.video_url).toBe('')
    expect(CharitySettingsSchema.safeParse({ video_url: 'https://youtu.be/abc123' }).success).toBe(true)
    expect(CharitySettingsSchema.safeParse({ video_url: 'https://www.instagram.com/reel/XyZ/' }).success).toBe(true)
    expect(CharitySettingsSchema.safeParse({ video_url: '' }).success).toBe(true)
  })
  it('rejects a link no provider can embed', () => {
    const r = CharitySettingsSchema.safeParse({ video_url: 'https://example.com/video.mp4' })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].path).toEqual(['video_url'])
  })
})
