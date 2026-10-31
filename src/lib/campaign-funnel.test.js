// FIFTYPLUS.1 — the campaign_funnel block: factory defaults, the pure
// config/copy helpers the public routes and the /50plus page share.
import { describe, it, expect } from 'vitest'
import {
  parseAllowKeywords, resolveCampaignKey, campaignFunnelBlock, campaignFunnelConfig,
  campaignFunnelCopy, CAMPAIGN_FUNNEL_CLIENT_FIELDS,
} from './campaign-funnel'
import { newBlockOfType, blocksOrDefault } from './landing-page-blocks'

describe('campaign_funnel block', () => {
  it('factory seeds the 50plus defaults', () => {
    const b = newBlockOfType('campaign_funnel', { brand: 'UN1T Stillorgan' })
    expect(b.type).toBe('campaign_funnel')
    expect(b.campaign).toBe('50plus')
    expect(b.class_keywords).toBe('50+')
    expect(b.heading).toBe('A free trial of The 50+ Club')
    expect(b.trial_membership_id).toBe('')
    expect(b.trial_plan_code).toBe('')
    expect(b.consent_label).toContain('UN1T Stillorgan')
  })
  it('blocksOrDefault keeps the block', () => {
    const b = newBlockOfType('campaign_funnel')
    expect(blocksOrDefault([b])).toEqual([b])
  })
})

describe('parseAllowKeywords', () => {
  it('normalises string and array forms', () => {
    expect(parseAllowKeywords('50+\n The Elites ,')).toEqual(['50+', 'the elites'])
    expect(parseAllowKeywords([' 50+ ', ''])).toEqual(['50+'])
    expect(parseAllowKeywords(null)).toEqual([])
  })
})

describe('resolveCampaignKey', () => {
  it('sanitises like a landing path and nulls a blank', () => {
    expect(resolveCampaignKey(' 50Plus ')).toBe('50plus')
    expect(resolveCampaignKey('50plus?x=1')).toBe('50plusx1')
    expect(resolveCampaignKey('')).toBe(null)
    expect(resolveCampaignKey(undefined)).toBe(null)
  })
})

describe('campaignFunnelBlock', () => {
  const blocks = [{ type: 'class_funnel' }, { type: 'campaign_funnel', campaign: '50plus', heading: 'x' }]
  it('finds by exact campaign key', () => {
    expect(campaignFunnelBlock(blocks, '50plus').heading).toBe('x')
    expect(campaignFunnelBlock(blocks, '50PLUS')).toBe(null)
    expect(campaignFunnelBlock(blocks, 'hyrox')).toBe(null)
    expect(campaignFunnelBlock(null, '50plus')).toBe(null)
  })
})

describe('campaignFunnelConfig', () => {
  const base = { type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }
  it('derives defaults from the path and campaign', () => {
    const c = campaignFunnelConfig(base, { landingPath: 'stillorgan' })
    expect(c).toMatchObject({
      campaign: '50plus', tag: 'stillorgan-50plus', leadSource: 'meta_50plus',
      eventSourceUrl: 'https://www.un1tdublin.com/50plus', allowKeywords: ['50+'],
      configured: false, trialMembershipId: null, trialPlanCode: null,
    })
  })
  it('a half-set trial pair is not configured', () => {
    expect(campaignFunnelConfig({ ...base, trial_membership_id: 'm1' }, { landingPath: 'stillorgan' }).configured).toBe(false)
    expect(campaignFunnelConfig({ ...base, trial_membership_id: ' m1 ', trial_plan_code: 'p1' }, { landingPath: 'stillorgan' }))
      .toMatchObject({ configured: true, trialMembershipId: 'm1', trialPlanCode: 'p1' })
  })
  it('operator overrides win', () => {
    const c = campaignFunnelConfig({ ...base, tag: 'custom-tag', lead_source: 'meta_x', event_source_url: 'https://x.test/p' }, { landingPath: 'stillorgan' })
    expect(c).toMatchObject({ tag: 'custom-tag', leadSource: 'meta_x', eventSourceUrl: 'https://x.test/p' })
  })
  it('an empty keyword list stays empty (offers nothing)', () => {
    expect(campaignFunnelConfig({ ...base, class_keywords: '' }, { landingPath: 'stillorgan' }).allowKeywords).toEqual([])
  })
})

describe('campaignFunnelCopy', () => {
  it('every client field has a non-empty default and no em-dash', () => {
    const copy = campaignFunnelCopy({}, { brand: '' })
    for (const k of CAMPAIGN_FUNNEL_CLIENT_FIELDS) {
      if (k === 'video_url' || k === 'poster_url') continue // media: null until uploaded
      const v = copy[k]
      if (Array.isArray(v)) { expect(v.length, k).toBeGreaterThan(0); continue }
      expect(typeof v === 'string' && v.trim().length > 0, k).toBe(true)
      expect(v, k).not.toContain('—')
    }
  })
  it('a blank field falls back to its default, a set one wins', () => {
    expect(campaignFunnelCopy({ heading: '  ' }, {}).heading).toBe('A free trial of The 50+ Club')
    expect(campaignFunnelCopy({ heading: 'Hello' }, {}).heading).toBe('Hello')
  })
  it('expect_cards fall back when the saved list is unusable', () => {
    expect(campaignFunnelCopy({ expect_cards: [{ title: '', body: 'x' }] }, {}).expect_cards).toHaveLength(3)
    expect(campaignFunnelCopy({ expect_cards: [{ title: 'One', body: 'x' }] }, {}).expect_cards).toEqual([{ title: 'One', body: 'x' }])
  })
  it('show_sections keeps only the known names', () => {
    expect(campaignFunnelCopy({ show_sections: ['reviews', 'hero', 'stats'] }, {}).show_sections).toEqual(['reviews', 'stats'])
  })
  it('never carries ids, keywords or the tag', () => {
    for (const k of ['trial_membership_id', 'trial_plan_code', 'class_keywords', 'tag', 'lead_source', 'event_source_url', 'campaign']) {
      expect(CAMPAIGN_FUNNEL_CLIENT_FIELDS).not.toContain(k)
    }
  })
})

// HEROVIDEO.1 — the hero's framing and sound default travel with the copy.
import { CAMPAIGN_FUNNEL_VIDEO_DEFAULTS, campaignFunnelClientCopy } from './campaign-funnel'

describe('campaignFunnelCopy — video framing and sound', () => {
  it('defaults to top framing with sound on, and the factory seeds the same', () => {
    const copy = campaignFunnelCopy({})
    expect(copy.video_focus).toBe('top')
    expect(copy.sound_default).toBe('on')
    expect(CAMPAIGN_FUNNEL_VIDEO_DEFAULTS).toEqual({ video_focus: 'top', sound_default: 'on' })
    const block = newBlockOfType('campaign_funnel')
    expect(block.video_focus).toBe('top')
    expect(block.sound_default).toBe('on')
  })

  it('keeps a known value and reads an unknown one as the default', () => {
    expect(campaignFunnelCopy({ video_focus: 'center', sound_default: 'muted' })).toMatchObject({ video_focus: 'center', sound_default: 'muted' })
    expect(campaignFunnelCopy({ video_focus: 'left', sound_default: 'loud' })).toMatchObject({ video_focus: 'top', sound_default: 'on' })
  })

  it('both reach the browser (presentation, not configuration)', () => {
    expect(CAMPAIGN_FUNNEL_CLIENT_FIELDS).toEqual(expect.arrayContaining(['video_focus', 'sound_default']))
    const client = campaignFunnelClientCopy(campaignFunnelCopy({ video_focus: 'bottom' }))
    expect(client.video_focus).toBe('bottom')
    expect(client.sound_default).toBe('on')
  })
})
