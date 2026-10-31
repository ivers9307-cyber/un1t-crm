// ExpectStrip — FIFTYPLUS.1: the "what to expect" strip under a campaign
// page's hero. Three cards written for the reader the page is for; every word
// is the block's (campaignFunnelCopy). Server-safe, no hooks.
//
// PAGES.1 — `renderText(path, value)` (optional) renders each word instead of
// the plain text: the editor's preview passes EditableText through it (path
// ['eyebrow'] | ['heading'] | ['cards', i, 'title'] | ['cards', i, 'body']).
// Without it the strip renders exactly as before.

export default function ExpectStrip({ eyebrow, heading, cards, renderText = null }) {
  const text = (path, value) => (renderText ? renderText(path, value) : value)
  const items = Array.isArray(cards) ? cards.filter((c) => c && c.title).slice(0, 3) : []
  if (items.length === 0) return null
  return (
    <section className="bg-white text-black py-16 md:py-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        {eyebrow && <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-black/50 mb-3">{text(['eyebrow'], eyebrow)}</div>}
        {heading && <h2 className="font-display font-extrabold uppercase text-3xl md:text-4xl tracking-tight mb-8 md:mb-10">{text(['heading'], heading)}</h2>}
        <div className="grid gap-4 md:grid-cols-3 md:gap-6">
          {items.map((c, i) => (
            <div key={i} className="rounded-2xl bg-lp-pale p-6">
              <div className="font-display font-extrabold uppercase text-lg mb-2">{text(['cards', i, 'title'], c.title)}</div>
              {c.body && <p className="text-base text-black/65 leading-relaxed">{text(['cards', i, 'body'], c.body)}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
