// CLASSFIRST.1 — the one presentation resolver behind the one_class layout.
// /50plus (campaign_funnel), /trial (paid_trial) and /corp (corp_promo) all
// render CampaignHero + ExpectStrip round their card; this module answers
// what the hero and the strip show for any of the three blocks, and the
// words of the class step for the two class-first cards. Pure, no IO,
// importable from the client bundle (EditOfferLayout reads it live).
//
// The design is docs/superpowers/specs/2026-11-01-class-first-trial-corp-design.md.

import { campaignFunnelCopy, CAMPAIGN_FUNNEL_VIDEO_FOCUS, CAMPAIGN_FUNNEL_SOUND_DEFAULTS } from '@/lib/campaign-funnel'
import { CLASS_FIRST_STEP_KEYS, CLASS_FIRST_HERO_DEFAULTS, classFirstDefaultsFor } from '@/lib/class-first-copy'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The class step's words for a class-first block: the block's value, else the
 * type's default. `type` is 'paid_trial' | 'corp_promo' (the block's own type
 * when given, else this argument).
 */
export function classFirstStepCopy(block, type) {
  const b = block && typeof block === 'object' ? block : {}
  const d = classFirstDefaultsFor(b.type || type)
  const out = {}
  for (const k of CLASS_FIRST_STEP_KEYS) out[k] = str(b[k]) || d[k]
  return out
}

function expectCards(raw, fallback) {
  const cards = Array.isArray(raw)
    ? raw.filter((c) => c && typeof c === 'object' && str(c.title)).map((c) => ({ title: str(c.title), body: str(c.body) || '' }))
    : []
  return cards.length > 0 ? cards : fallback.map((c) => ({ ...c }))
}

/**
 * What the one_class layout shows round the card: the hero (video or poster,
 * eyebrow, heading, sub-copy) and the expect strip. A campaign_funnel block
 * is exactly campaignFunnelCopy; a paid_trial or corp_promo block reads its
 * own hero keys and, with neither video nor poster, takes the page's hero
 * photo (`heroImageUrl`) as the poster, so a page that predates this layout
 * keeps the photo it had.
 *
 * @param {object|null} block
 * @param {{ heroImageUrl?: string|null }} [opts]
 * @returns {{ hero: object, expect: { eyebrow: string, heading: string, cards: Array<{ title: string, body: string }> } }}
 */
export function oneClassPresentation(block, { heroImageUrl = null } = {}) {
  const b = block && typeof block === 'object' ? block : {}
  if (b.type === 'campaign_funnel') {
    const c = campaignFunnelCopy(b)
    return {
      hero: { videoUrl: c.video_url, posterUrl: c.poster_url, soundLabel: c.sound_label, videoFocus: c.video_focus, soundDefault: c.sound_default, eyebrow: c.eyebrow, heading: c.heading, subhead: c.subhead },
      expect: { eyebrow: c.expect_eyebrow, heading: c.expect_heading, cards: c.expect_cards },
    }
  }
  const d = classFirstDefaultsFor(b.type)
  const videoUrl = str(b.video_url)
  const posterUrl = str(b.poster_url) || (videoUrl ? null : str(heroImageUrl))
  return {
    hero: {
      videoUrl,
      posterUrl,
      soundLabel: str(b.sound_label) || CLASS_FIRST_HERO_DEFAULTS.sound_label,
      videoFocus: CAMPAIGN_FUNNEL_VIDEO_FOCUS.includes(b.video_focus) ? b.video_focus : CLASS_FIRST_HERO_DEFAULTS.video_focus,
      soundDefault: CAMPAIGN_FUNNEL_SOUND_DEFAULTS.includes(b.sound_default) ? b.sound_default : CLASS_FIRST_HERO_DEFAULTS.sound_default,
      // A corp_promo block's big `title` stands in for a blank eyebrow (the hero has no title slot).
      eyebrow: str(b.eyebrow) || (b.type === 'corp_promo' ? str(b.title) : null) || '',
      heading: str(b.heading) || '',
      subhead: str(b.subhead) || '',
    },
    expect: {
      eyebrow: str(b.expect_eyebrow) || d.expect_eyebrow,
      heading: str(b.expect_heading) || d.expect_heading,
      cards: expectCards(b.expect_cards, d.expect_cards),
    },
  }
}

/**
 * The done screen's class line: `{class}`, `{day}` (the day label) and
 * `{time}` filled from a public class. '' with no class or no template.
 */
export function classLine(template, cls) {
  const t = str(template)
  if (!t || !cls || typeof cls !== 'object') return ''
  return t
    .replace(/\{class\}/g, str(cls.name) || 'your class')
    .replace(/\{day\}/g, str(cls.day_label) || '')
    .replace(/\{time\}/g, str(cls.time) || '')
    .replace(/\s+/g, ' ')
    .trim()
}
