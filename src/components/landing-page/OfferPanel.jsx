// OfferPanel — the white foundation-offer card inside the lead-form
// section (HATCH-OFFER.1). Inverted on purpose: a solid white panel
// on the black page is what makes the price the first thing the eye
// lands on.
//
// Pure presentation, no state. Every string arrives from the block's
// operator-editable `offer` group, already normalised by offerOf()
// in src/lib/landing-page-blocks.js — so `cta_url` is trimmed and
// `ticks` is a POSITION-PRESERVING array whose blanks are '' (they
// are skipped here by index, never compacted; see offerOf).
//
// Its own file rather than another section inside BlockRenderers.jsx,
// which already carries every block renderer plus SiteHeader and
// SiteFooter.

import { E } from './EditableField'

export default function OfferPanel({ offer, onEdit }) {
  const ticks = Array.isArray(offer.ticks) ? offer.ticks : []
  const href = offer.cta_url || ''
  return (
    <div className="lp-reveal lp-d1 rounded-2xl bg-white text-black p-8 md:p-10 flex flex-col">
      {/* Wraps on narrow screens: the chip is shrink-0, so without
          flex-wrap it overflowed the panel by ~64px at 376px and the
          section's overflow-hidden clipped "19 SEPTEMBER" off the end. */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-8">
        <div className="flex items-center gap-4">
          <span className="h-px w-10 bg-black/25" aria-hidden="true" />
          <span className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/45">
            <E value={offer.eyebrow} onEdit={onEdit} path={['offer', 'eyebrow']} />
          </span>
        </div>
        {offer.deadline ? (
          <span className="shrink-0 rounded-full bg-black text-white text-[10px] uppercase tracking-[0.16em] font-bold px-3 py-1.5">
            <E value={offer.deadline} onEdit={onEdit} path={['offer', 'deadline']} />
          </span>
        ) : null}
      </div>

      {/* The strike is decorative: it reads as "it USED to be €219",
          while the truth is that it BECOMES €219 on the 19th. Sighted
          visitors get the direction from the deadline chip and the
          page copy; the visually-hidden note gives it to everyone
          else, and stays operator-editable like the rest. */}
      <div className="flex items-end gap-4 flex-wrap mb-8">
        {offer.was_price ? (
          <>
            <s
              className="lp-was-strike font-display font-extrabold text-3xl md:text-4xl text-black/40 tracking-tight pb-1"
              aria-hidden="true"
            >
              {offer.was_price}
            </s>
            <span className="sr-only">{offer.was_price} {offer.was_price_note}</span>
          </>
        ) : null}
        <span className="font-display font-extrabold text-6xl md:text-7xl leading-[0.85] tracking-tight">
          {offer.price}
        </span>
        <span className="whitespace-pre-line text-[11px] uppercase tracking-[0.18em] font-extrabold text-black/55 leading-[1.5] pb-2">
          {offer.unit}
        </span>
      </div>

      <ul className="flex flex-col gap-3 mb-9">
        {/* Skip blanks BY INDEX rather than filtering the list: `i` has
            to stay the raw array position or inline edits land on the
            wrong tick. */}
        {ticks.map((t, i) => (t ? (
          <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-black/70">
            <span className="opacity-55" aria-hidden="true">✓</span>
            <span><E value={t} onEdit={onEdit} path={['offer', 'ticks', i]} /></span>
          </li>
        ) : null))}
      </ul>

      {href ? (
        <div className="mt-auto">
          <a href={href} rel="noopener" className="lp-btn lp-btn-invert">
            {offer.cta_label}
            <span className="lp-btn-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      ) : null}
    </div>
  )
}
