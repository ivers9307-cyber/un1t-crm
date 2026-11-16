'use client'

// PAGES.1 (Task 17) — the editor preview's pinned offer region: the page's
// own layout above its editable blocks, composed by EditModeOverlay when the
// [slug] route hands it an `offerLayout` (the contract is in that route's
// offerElementFor and in the overlay's header).
//
//   frosted    the offer card over the hero photo (FrostedHero, the public
//              page's own markup). The card's words are edited in the left
//              panel, not here, and the card shows them as they are typed.
//   one_class  CampaignHero (coach video, its eyebrow, heading and sub-copy
//              edited in place) wrapping the booking card, then ExpectStrip
//              (its eyebrow, heading and cards edited in place). The words
//              come from the LIVE pinned block (oneClassPresentation, for a
//              campaign_funnel, a paid_trial or a corp_promo block:
//              CLASSFIRST.1), so the hero tracks every keystroke from either
//              side. Only the campaign card's own four words are edited in
//              place; a trial or promo card's words are the left panel's.
//              Every card shows the live block's words (liveOffer).
//
// FUNNELPREVIEW.1 — the CARD tracks the editor too. The route hands the
// card's props as plain data (`layout.offerProps`, and `layout.offerLive` for
// a promo) and `liveOffer` rebuilds the card from them with the live block's
// words, for all four cards. It used to clone `layout.offer`, which only ever
// worked in a test: across the server boundary that element arrives as a
// lazy reference (its copy shares `expect_cards` with the strip, and a shared
// object makes the enclosing element lazy), `isValidElement` is false, the
// clone was skipped, and every card word (the reassurance line first noticed)
// stayed as the server seeded it. With no `offerProps` (the route's no-path
// notice) the region renders `layout.offer` as it is.
//
// The whole region selects the offer block on a click outside anything
// interactive; the booking card itself stays live (spec §7). Every edit goes
// out through `onEditField(path, value)`, which the overlay judges.

import CampaignHero from './CampaignHero'
import ExpectStrip from './ExpectStrip'
import FrostedHero from './FrostedHero'
import EditableText from './EditableText'
import CampaignFunnel, { EDITABLE_COPY_KEYS } from './CampaignFunnel'
import PaidTrialFunnel from './PaidTrialFunnel'
import CorpPromoFunnel from './CorpPromoFunnel'
import ClassFunnel from '@/components/ClassFunnel'
import { campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import { oneClassPresentation, classFirstStepCopy } from '@/lib/class-first-funnel'
import { corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { clientTrialBlock } from '@/lib/trial-studio-view'
import { classFunnelWordProps } from '@/lib/landing-page-blocks'
import { STUDIO_OFFER_KEYS, ATTRIBUTION_KEYS } from '@/lib/landing-page-offers'

export const INTERACTIVE = 'button, a, input, select, textarea, iframe, [contenteditable="true"]'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const EXPECT_KEY = { eyebrow: 'expect_eyebrow', heading: 'expect_heading' }

// The block's own cards line up with the rendered ones (every one titled), so
// a card edit can name its index; otherwise the strip shows the defaults or a
// filtered list, and the edit writes the whole list it shows.
const ownCardsAlign = (block) => Array.isArray(block?.expect_cards)
  && block.expect_cards.length > 0
  && block.expect_cards.every((c) => c && typeof c === 'object' && str(c.title))

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * The offer card with the LIVE block's words: the route's plain props
 * (`layout.offerProps`) with the words re-read off `pinned`, by block type.
 * `layout.offer` as the route built it when there is no pinned block or no
 * props to rebuild from. Only words change: where the card posts, what it
 * sells and its studio keys stay the server's.
 */
export function liveOffer(layout, pinned, onEditField) {
  const props = layout?.offerProps
  if (!isObj(pinned) || !isObj(props)) return layout?.offer ?? null

  if (pinned.type === 'campaign_funnel') {
    return (
      <CampaignFunnel
        {...props}
        copy={{
          ...(props.copy || {}),
          ...campaignFunnelClientCopy(campaignFunnelCopy(pinned)),
          // The server's wording names the studio's brand; keep it unless the block has its own.
          consent_label: str(pinned.consent_label) || props.copy?.consent_label,
        }}
        // The card's own four words are edited in place, and nothing else.
        onEditCopy={(key, v) => { if (EDITABLE_COPY_KEYS.includes(key)) onEditField([key], v) }}
      />
    )
  }

  if (pinned.type === 'corp_promo') {
    const live = isObj(layout.offerLive) ? layout.offerLive : {}
    const raw = corpPromoCopyFromBlocks([pinned], live.promoKey ?? null, { platform: live.platform || undefined, kind: live.kind || undefined })
    if (live.unavailableText) raw.unavailable_text = live.unavailableText
    const tokens = isObj(live.tokens) ? live.tokens : {}
    const copy = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.map((t) => fillCorpPromoTokens(t, tokens)) : fillCorpPromoTokens(v, tokens)]))
    return <CorpPromoFunnel {...props} copy={copy} stepCopy={classFirstStepCopy(pinned, 'corp_promo')} />
  }

  if (pinned.type === 'paid_trial') {
    // The page's words are the same at every studio; each studio keeps its
    // own product, price and label (its row's keys, never the page's).
    const studioKeys = [...STUDIO_OFFER_KEYS.paid_trial, ...ATTRIBUTION_KEYS]
    const words = Object.fromEntries(Object.entries(clientTrialBlock(pinned)).filter(([k]) => !studioKeys.includes(k)))
    const studios = (Array.isArray(props.studios) ? props.studios : []).map((s) => (isObj(s) ? { ...s, block: { ...(s.block || {}), ...words } } : s))
    return <PaidTrialFunnel {...props} studios={studios} />
  }

  if (pinned.type === 'class_funnel') {
    return <ClassFunnel {...props} {...classFunnelWordProps(pinned)} />
  }

  return layout.offer ?? null
}

function OneClassRegion({ layout, pinned, heroBlock, onEditField }) {
  // The live words off the pinned block, whatever its type; the page's hero
  // photo stands in for a missing poster as on the public page.
  const live = pinned ? oneClassPresentation(pinned, { heroImageUrl: str(heroBlock?.image_url) || layout.heroImageUrl || null }) : null
  const hero = live ? live.hero : (layout.hero || {})
  const strip = live ? live.expect : (layout.expect || {})
  const editable = (path, value, multiline) => (
    <EditableText value={value || ''} multiline={multiline} onChange={(v) => onEditField(path, v)} />
  )
  const heroText = pinned ? (path, value) => editable(path, value, path[0] === 'subhead') : null
  const stripText = pinned
    ? (path, value) => {
      const multiline = path[path.length - 1] === 'body'
      if (path[0] !== 'cards') return editable([EXPECT_KEY[path[0]]], value, multiline)
      const [, i, field] = path
      if (ownCardsAlign(pinned)) return editable(['expect_cards', i, field], value, multiline)
      return (
        <EditableText
          value={value || ''}
          multiline={multiline}
          onChange={(v) => onEditField(['expect_cards'], strip.cards.map((c, j) => (j === i ? { ...c, [field]: v } : c)))}
        />
      )
    }
    : null

  const offer = liveOffer(layout, pinned, onEditField)

  return (
    <>
      <CampaignHero {...hero} renderText={heroText}>{offer}</CampaignHero>
      <ExpectStrip eyebrow={strip.eyebrow} heading={strip.heading} cards={strip.cards} renderText={stripText} />
    </>
  )
}

export default function EditOfferLayout({ layout, pinned = null, heroBlock = null, label = '', selected = false, onSelect, onEditField, regionRef }) {
  if (!layout || (layout.kind !== 'frosted' && layout.kind !== 'one_class')) return null
  const selectable = Boolean(pinned)
  return (
    <div
      data-pinned-offer=""
      ref={regionRef}
      onClick={(e) => {
        if (!selectable || e.target.closest(INTERACTIVE)) return
        e.stopPropagation()
        onSelect?.()
      }}
      className={`relative group transition-all duration-150 ${selectable ? 'cursor-pointer' : ''} ${
        selected
          ? 'outline outline-4 outline-blue-500 outline-offset-[-4px]'
          : selectable ? 'hover:outline hover:outline-2 hover:outline-blue-300/60 hover:outline-offset-[-2px]' : ''
      }`}
    >
      {layout.kind === 'frosted' ? (
        <FrostedHero
          anchor={layout.anchor}
          // The page's hero block is the photo, as on the public page; the server's when it has none.
          heroImageUrl={str(heroBlock?.image_url) || layout.heroImageUrl || null}
          offer={liveOffer(layout, pinned, onEditField)}
          scrollCueLabel={layout.scrollCueLabel || null}
        />
      ) : (
        <OneClassRegion layout={layout} pinned={pinned} heroBlock={heroBlock} onEditField={onEditField} />
      )}
      {/* The type badge, as on every block; no toolbar (the offer is pinned). */}
      {selectable && label && (
        <div
          className={`absolute top-2 left-2 z-30 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-semibold pointer-events-none transition-opacity ${
            selected ? 'opacity-100 bg-blue-500 text-white' : 'opacity-0 bg-blue-500/80 text-white group-hover:opacity-100'
          }`}
        >
          {label}
        </div>
      )}
    </div>
  )
}
