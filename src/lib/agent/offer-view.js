// MIAPAGES.1 — what Mia sees of a live page or a storefront offer.
//
// Pure: records in, model-facing entries out. Nothing internal leaves this
// file: no promo key, plan code, membership id, product id, offer id, stock
// number, tag or lead source. Every label (price, end date) is made here, on
// the studio's clock, so Mia copies it and does no maths.
//
// The design is docs/superpowers/specs/2026-11-23-mia-live-pages-and-offers-design.md.
import { formatTrialPrice, trialTicks } from '@/lib/paid-trial'
import { campaignFunnelCopy } from '@/lib/campaign-funnel'
import { corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { dateKeyIn, timeLabelIn, dayStrIn } from '@/lib/location-time'
import { dateLabel } from './event-date-label'

const SUMMARY_MAX = 200

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** One line, at most SUMMARY_MAX characters, or null. */
function oneLine(text) {
  const flat = str(String(text ?? '').replace(/\s+/g, ' '))
  if (!flat) return null
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : flat
}

/** 'Sun 29 Nov' for a studio-local date 'YYYY-MM-DD'. */
export function dayLabel(isoDate) {
  return dateLabel(isoDate)
}

/** 'Mon 30 Nov, 23:59' for an instant, on the studio's clock. */
export function dateTimeLabel(iso, zone) {
  return `${dateLabel(dateKeyIn(iso, zone))}, ${timeLabelIn(iso, zone)}`
}

const FOR_BY_TYPE = Object.freeze({
  paid_trial: 'Someone new who wants to try the studio.',
  sale: 'Anyone buying a pack, a membership or a gift.',
})

/**
 * Who a page is for: the operator's own line when set (chrome.mia_note), else
 * a default by offer type. Pages aimed at a group (a promo, one class) and
 * pages with no offer speak through their own title and summary.
 */
export function forLine(page, summary) {
  const note = str(page?.chrome?.mia_note)
  if (note) return note
  const fixed = FOR_BY_TYPE[page?.offer_type]
  if (fixed) return fixed
  const title = str(page?.title) || ''
  return summary ? `${title}: ${summary}` : title
}

function promoClassCount(promo) {
  const n = promo?.kind === 'open_week' ? promo?.maxClasses : promo?.credits
  return Number.isInteger(n) && n > 0 ? n : null
}

function summaryFor({ page, mergedOffer, promo, withOffer, studioName }) {
  const fallback = oneLine(page?.chrome?.meta_description)
  if (!withOffer) return fallback
  const block = mergedOffer && typeof mergedOffer === 'object' ? mergedOffer : {}
  if (page.offer_type === 'paid_trial') {
    const ticks = trialTicks(block)
    if (ticks.length > 0) return oneLine(ticks.join('; '))
    return Number.isInteger(block.duration_days) ? `${block.duration_days} days` : fallback
  }
  if (page.offer_type === 'one_class') return oneLine(campaignFunnelCopy(block).subhead)
  if (page.offer_type === 'promo_credits') {
    const copy = corpPromoCopyFromBlocks([block], str(block.promo_key), { platform: promo?.platform, kind: promo?.kind })
    const count = promoClassCount(promo)
    const tokens = { studio_name: studioName || 'the studio', credits: promo?.credits ?? '', max_classes: promo?.maxClasses ?? '' }
    const heading = fillCorpPromoTokens(copy.heading, tokens)
    const subhead = fillCorpPromoTokens(copy.subhead, tokens)
    const lead = count ? `${count} free ${count === 1 ? 'class' : 'classes'}. ` : ''
    return oneLine(`${lead}${heading}. ${subhead}`)
  }
  return fallback
}

function priceFor({ page, mergedOffer, promo }) {
  if (page.offer_type === 'paid_trial' && Number.isInteger(mergedOffer?.price_cents)) {
    return formatTrialPrice(mergedOffer.price_cents, str(mergedOffer.currency) || 'EUR')
  }
  if (page.offer_type === 'promo_credits' && promo) return 'Free'
  return null
}

/**
 * One live page as Mia sees it. `withOffer: false` (a studio page whose trial
 * a campaign page already lists, a sale page, a page with no offer) carries
 * the title, a summary and the link, and no price or end date.
 * `priority` is 'normal' here; rankPages sets the real one.
 */
export function pageEntry({ page, mergedOffer = null, promo = null, zone, url, withOffer, studioName = '', now = new Date() }) {
  const summary = summaryFor({ page, mergedOffer, promo, withOffer, studioName })
  const windowed = withOffer && page.offer_type === 'promo_credits' && promo?.kind === 'open_week'
  const ends = windowed && str(promo?.windowEndsOn)
  // An open week takes sign-ups before its first day: say when it starts.
  const startsOn = windowed && str(promo?.windowStartsOn)
  const starts = startsOn && dayStrIn(now, zone) < startsOn ? startsOn : null
  return {
    title: str(page.title) || '',
    kind: page.offer_type,
    for: forLine(page, summary),
    summary,
    price_label: withOffer ? priceFor({ page, mergedOffer, promo }) : null,
    starts_label: starts ? dayLabel(starts) : null,
    ends_label: ends ? dayLabel(ends) : null,
    priority: 'normal',
    url,
  }
}

/**
 * Order a studio's pages and say which leads.
 *   1. operator "Lead with this" (chrome.mia_priority 'lead'), by title
 *   2. an offer with an end date, soonest first
 *   3. an open-ended offer, the paid trial first (it is the baseline)
 *   4. pages with no offer of their own
 *   5. operator "Only if asked" (chrome.mia_priority 'ask_only')
 * 'lead' goes to every page in group 1, or with none there, to the first
 * entry of groups 2 and 3.
 * @param {Array<{ entry: object, page: object, endsOn: string|null, withOffer: boolean }>} items
 */
export function rankPages(items) {
  const list = Array.isArray(items) ? items : []
  const group = (it) => {
    const p = it.page?.chrome?.mia_priority
    if (p === 'lead') return 1
    if (p === 'ask_only') return 5
    if (!it.withOffer) return 4
    return it.endsOn ? 2 : 3
  }
  const isTrial = (it) => it.page?.offer_type === 'paid_trial'
  const byTitle = (a, b) => String(a.entry.title).localeCompare(String(b.entry.title))
  const sorted = list
    .map((it, index) => ({ it, g: group(it), index }))
    .sort((a, b) => a.g - b.g
      || (a.g === 2 ? String(a.it.endsOn).localeCompare(String(b.it.endsOn)) : 0)
      || (a.g === 1 || a.g === 2 ? byTitle(a.it, b.it) : 0)
      // The paid trial is the baseline for someone new: it leads the other
      // open-ended offers (a standing free promo, a one-class page).
      || (a.g === 3 ? Number(isTrial(b.it)) - Number(isTrial(a.it)) : 0)
      || a.index - b.index)
  const operatorLeads = sorted.some((s) => s.g === 1)
  const autoLead = operatorLeads ? null : sorted.find((s) => s.g === 2 || s.g === 3)
  return sorted.map((s) => ({
    ...s.it.entry,
    priority: s.g === 1 || s === autoLead ? 'lead' : s.g === 5 ? 'only_if_asked' : 'normal',
  }))
}

/**
 * One storefront offer as Mia sees it. `stock` is an offerStockStatus result,
 * or null when the offer has no limit or its stock could not be read.
 */
export function storeEntry({ offer, stock = null, zone, url, now = new Date() }) {
  const opens = offer.starts_at && Date.parse(offer.starts_at) > now.getTime()
  return {
    name: offer.name,
    category: offer.category,
    bonus: str(offer.bonus_headline),
    price_label: formatTrialPrice(offer.price_cents, str(offer.currency) || 'EUR'),
    ends_label: offer.ends_at ? dateTimeLabel(offer.ends_at, zone) : null,
    opens_label: opens ? dateTimeLabel(offer.starts_at, zone) : null,
    // Named for what Mia may say. The un1t.online prompts never use the word
    // "limited" (it reads as a hint about class places), so neither does this.
    while_stocks_last: Number.isInteger(offer.stock_limit) && offer.stock_limit > 0,
    sold_out: stock?.state === 'sold_out',
    url,
  }
}
