// ExpectStrip — FIFTYPLUS.1: the "what to expect" strip under a campaign
// page's hero. Three cards written for the reader the page is for; every word
// is the block's (campaignFunnelCopy). Server-safe, no hooks.

export default function ExpectStrip({ eyebrow, heading, cards }) {
  const items = Array.isArray(cards) ? cards.filter((c) => c && c.title).slice(0, 3) : []
  if (items.length === 0) return null
  return (
    <section className="bg-white text-black py-16 md:py-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        {eyebrow && <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-black/50 mb-3">{eyebrow}</div>}
        {heading && <h2 className="font-display font-extrabold uppercase text-3xl md:text-4xl tracking-tight mb-8 md:mb-10">{heading}</h2>}
        <div className="grid gap-4 md:grid-cols-3 md:gap-6">
          {items.map((c, i) => (
            <div key={i} className="rounded-2xl bg-lp-pale p-6">
              <div className="font-display font-extrabold uppercase text-lg mb-2">{c.title}</div>
              {c.body && <p className="text-base text-black/65 leading-relaxed">{c.body}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
