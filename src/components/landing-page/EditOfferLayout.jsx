'use client'

// PAGES.1 (Task 17) — the editor preview's pinned offer region: the page's
// own layout above its editable blocks, composed by EditModeOverlay when the
// [slug] route hands it an `offerLayout` (the contract is in that route's
// offerElementFor and in the overlay's header).
//
//   frosted    the offer card over the hero photo (FrostedHero, the public
//              page's own markup). The card's words are edited in the left
//              panel, not here.
//   one_class  CampaignHero (coach video, its eyebrow, heading and sub-copy
//              edited in place) wrapping the booking card, then ExpectStrip
//              (its eyebrow, heading and cards edited in place). The words
//              come from the LIVE pinned block (oneClassPresentation, for a
//              campaign_funnel, a paid_trial or a corp_promo block:
//              CLASSFIRST.1), so the hero tracks every keystroke from either
//              side. Only the campaign card's own four words are edited in
//              place; a trial or promo card's words are the left panel's.
//
// The whole region selects the offer block on a click outside anything
// interactive; the booking card itself stays live (spec §7). Every edit goes
// out through `onEditField(path, value)`, which the overlay judges.

import { cloneElement, isValidElement } from 'react'
import CampaignHero from './CampaignHero'
import ExpectStrip from './ExpectStrip'
import FrostedHero from './FrostedHero'
import EditableText from './EditableText'
import { EDITABLE_COPY_KEYS } from './CampaignFunnel'
import { campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import { oneClassPresentation } from '@/lib/class-first-funnel'

export const INTERACTIVE = 'button, a, input, select, textarea, iframe, [contenteditable="true"]'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const EXPECT_KEY = { eyebrow: 'expect_eyebrow', heading: 'expect_heading' }

// The block's own cards line up with the rendered ones (every one titled), so
// a card edit can name its index; otherwise the strip shows the defaults or a
// filtered list, and the edit writes the whole list it shows.
const ownCardsAlign = (block) => Array.isArray(block?.expect_cards)
  && block.expect_cards.length > 0
  && block.expect_cards.every((c) => c && typeof c === 'object' && str(c.title))

function OneClassRegion({ layout, pinned, heroBlock, onEditField }) {
  // The live words off the pinned block, whatever its type; the page's hero
  // photo stands in for a missing poster as on the public page.
  const live = pinned ? oneClassPresentation(pinned, { heroImageUrl: str(heroBlock?.image_url) || layout.heroImageUrl || null }) : null
  const hero = live ? live.hero : (layout.hero || {})
  const strip = live ? live.expect : (layout.expect || {})
  // The campaign card's own four words are edited in place (its copy prop); a
  // trial or promo card is rendered as the route built it.
  const copy = pinned?.type === 'campaign_funnel' ? campaignFunnelCopy(pinned) : null

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

  // The live card, with the live words and the hook for its own four (never
  // onto a plain element, such as the route's no-path notice).
  const offer = copy && isValidElement(layout.offer) && typeof layout.offer.type !== 'string'
    ? cloneElement(layout.offer, {
      copy: {
        ...(layout.offer.props.copy || {}),
        ...campaignFunnelClientCopy(copy),
        // The server's wording names the studio's brand; keep it unless the block has its own.
        consent_label: str(pinned.consent_label) || layout.offer.props.copy?.consent_label,
      },
      onEditCopy: (key, v) => { if (EDITABLE_COPY_KEYS.includes(key)) onEditField([key], v) },
    })
    : layout.offer

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
          offer={layout.offer}
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
