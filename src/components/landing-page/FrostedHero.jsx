// PAGES.1 — the frosted layout's hero: the photo with the offer card as a
// frosted panel and the cue down to the blocks. One piece shared by
// FrostedCardLayout (the public page, a server component) and the editor's
// preview (EditOfferLayout, a client component), so the two look the same.
// Server-safe, no hooks.
//
//   anchor          the section's id (the CTA target, without '#')
//   heroImageUrl    the photo behind the card, or null
//   offer           the card
//   scrollCueLabel  the cue under the card pointing at the blocks, or null

export const learnMoreIdFor = (anchor) => `${anchor}-learn-more`

export default function FrostedHero({ anchor = 'offer', heroImageUrl = null, offer = null, scrollCueLabel = null }) {
  return (
    <section id={anchor} className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
      {heroImageUrl && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${heroImageUrl})` }} />
        </div>
      )}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }} />
      <div className={`relative z-10 flex-1 flex items-center justify-center px-5 pt-28 ${scrollCueLabel ? 'pb-6' : 'pb-16'}`}>
        {offer}
      </div>
      {scrollCueLabel && (
        <div className="relative z-10 flex justify-center pb-8">
          <a href={`#${learnMoreIdFor(anchor)}`} className="group flex flex-col items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-white/80 transition-colors hover:text-white">
            {scrollCueLabel}
            <svg className="lp-cue w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </a>
        </div>
      )}
    </section>
  )
}
