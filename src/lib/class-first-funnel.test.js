// CLASSFIRST.1 — the one presentation resolver behind the one_class layout
// (/50plus, /trial, /corp): the hero, the expect strip and the class step's
// words for any of the three offer blocks, each blank field on its default.
import { describe, it, expect } from 'vitest'
import {
  CLASS_FIRST_STEP_KEYS, PAID_TRIAL_CLASS_FIRST_DEFAULTS, CORP_PROMO_CLASS_FIRST_DEFAULTS,
} from './class-first-copy.js'
import { classFirstStepCopy, oneClassPresentation, classLine } from './class-first-funnel.js'
import { campaignFunnelCopy } from './campaign-funnel.js'

describe('classFirstStepCopy', () => {
  it('a paid_trial block with nothing set reads every step default', () => {
    const c = classFirstStepCopy({ type: 'paid_trial' }, 'paid_trial')
    for (const k of CLASS_FIRST_STEP_KEYS) expect(c[k]).toBe(PAID_TRIAL_CLASS_FIRST_DEFAULTS[k])
    expect(c.pick_title).toBe('Pick your first class')
    expect(c.skip_class_label).toBe('Continue without picking a class')
  })
  it('a corp_promo block has its own defaults, and a set word wins; a blank one falls back', () => {
    const c = classFirstStepCopy({ pick_title: '  Choose a class ', details_body: '   ' }, 'corp_promo')
    expect(c.pick_title).toBe('Choose a class')
    expect(c.details_body).toBe(CORP_PROMO_CLASS_FIRST_DEFAULTS.details_body)
    expect(c.done_class_body).toContain('by email')
  })
  it('no em-dashes in any default', () => {
    for (const d of [PAID_TRIAL_CLASS_FIRST_DEFAULTS, CORP_PROMO_CLASS_FIRST_DEFAULTS]) {
      for (const v of Object.values(d)) if (typeof v === 'string') expect(v).not.toContain('—')
    }
  })
})

describe('oneClassPresentation', () => {
  it('a campaign_funnel block reads exactly campaignFunnelCopy', () => {
    const block = { type: 'campaign_funnel', heading: 'A free trial', video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', video_focus: 'center', sound_default: 'muted' }
    const p = oneClassPresentation(block, { heroImageUrl: 'https://x/hero.jpg' })
    const c = campaignFunnelCopy(block)
    expect(p.hero).toEqual({ videoUrl: 'https://x/v.mp4', posterUrl: 'https://x/p.jpg', soundLabel: c.sound_label, videoFocus: 'center', soundDefault: 'muted', eyebrow: c.eyebrow, heading: 'A free trial', subhead: c.subhead })
    expect(p.expect).toEqual({ eyebrow: c.expect_eyebrow, heading: c.expect_heading, cards: c.expect_cards })
  })
  it('a paid_trial block with no media takes the page hero photo as its poster and the trial expect defaults', () => {
    const p = oneClassPresentation({ type: 'paid_trial', eyebrow: '14 day reset', heading: 'The 14 Day Reset', subhead: 'S' }, { heroImageUrl: 'https://x/hero.jpg' })
    expect(p.hero).toEqual({ videoUrl: null, posterUrl: 'https://x/hero.jpg', soundLabel: 'Tap for sound', videoFocus: 'top', soundDefault: 'on', eyebrow: '14 day reset', heading: 'The 14 Day Reset', subhead: 'S' })
    expect(p.expect.eyebrow).toBe('What to expect')
    expect(p.expect.cards).toHaveLength(3)
    expect(p.expect.cards[0]).toEqual(PAID_TRIAL_CLASS_FIRST_DEFAULTS.expect_cards[0])
  })
  it('a corp_promo block with a video keeps its own poster, and an unknown focus or sound reads as the default', () => {
    const p = oneClassPresentation({ type: 'corp_promo', heading: '3 free classes', video_url: 'https://x/c.mp4', poster_url: 'https://x/c.jpg', video_focus: 'left', sound_default: 'loud', expect_cards: [{ title: 'One', body: 'B' }, { title: '' }] }, { heroImageUrl: 'https://x/hero.jpg' })
    expect(p.hero.videoUrl).toBe('https://x/c.mp4')
    expect(p.hero.eyebrow).toBe('')
    expect(oneClassPresentation({ type: 'corp_promo', title: 'Exclusive Corporate Trial' }).hero.eyebrow).toBe('Exclusive Corporate Trial')
    expect(p.hero.posterUrl).toBe('https://x/c.jpg')
    expect(p.hero.videoFocus).toBe('top')
    expect(p.hero.soundDefault).toBe('on')
    expect(p.expect.cards).toEqual([{ title: 'One', body: 'B' }])
  })
  it('a null block is the paid_trial defaults with no media and no hero photo', () => {
    const p = oneClassPresentation(null)
    expect(p.hero.posterUrl).toBeNull()
    expect(p.hero.videoUrl).toBeNull()
    expect(p.expect.cards).toHaveLength(3)
  })
})

describe('classLine', () => {
  const cls = { event_id: 'a', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' }
  it('fills {class}, {day} and {time} from a public class', () => {
    expect(classLine('Your first class: {class}, {day} at {time}. We will confirm it shortly.', cls))
      .toBe('Your first class: THE 50+ CLUB, Mon, 5 Jan at 11:00. We will confirm it shortly.')
  })
  it('no class, or no template, is an empty string', () => {
    expect(classLine('x {class}', null)).toBe('')
    expect(classLine('', cls)).toBe('')
    expect(classLine(null, cls)).toBe('')
  })
})
