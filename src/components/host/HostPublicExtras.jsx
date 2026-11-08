// HOSTPAGE.2 — the public host page's extra sections. Pure render (server
// component on /h/<slug>): `HostAbout` sits between the hero and the events;
// `HostPublicExtras` renders photos, "What people say" (testimonials, then the
// ratings summary) and the collapsed past-events archive below them. Every
// section is omitted when its data is empty, and the whole thing renders
// nothing when all are. Past events carry no link: nothing to sell.

export function HostAbout({ text }) {
  const paragraphs = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return null
  return (
    <section className="mt-10 max-w-3xl" aria-label="About">
      {paragraphs.map((p, i) => <p key={i} className="mt-4 first:mt-0 text-base leading-relaxed text-white/80 whitespace-pre-line">{p}</p>)}
    </section>
  )
}

const Stars = ({ n }) => <span className="text-yellow-300" aria-label={`${n} out of 5`}>{'★'.repeat(n)}<span className="text-white/25">{'☆'.repeat(5 - n)}</span></span>

export default function HostPublicExtras({ photos = [], testimonials = [], ratingSummary = null, pastEvents = [], accentHex = null }) {
  const accent = accentHex || '#ffffff'
  const hasPhotos = Array.isArray(photos) && photos.length > 0
  const hasTestimonials = Array.isArray(testimonials) && testimonials.length > 0
  const hasRatings = !!ratingSummary && ratingSummary.count > 0
  const hasPast = Array.isArray(pastEvents) && pastEvents.length > 0
  if (!hasPhotos && !hasTestimonials && !hasRatings && !hasPast) return null

  return (
    <div className="mt-16 space-y-16">
      {hasPhotos && (
        <section aria-label="Photos">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((p, i) => (
              <li key={p.url}>
                <figure className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  <img src={p.url} alt={p.caption || `Photo ${i + 1}`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                  {p.caption && <figcaption className="px-3 py-2 text-xs text-white/60">{p.caption}</figcaption>}
                </figure>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(hasTestimonials || hasRatings) && (
        <section aria-label="What people say">
          <h2 className="text-xl font-semibold">What people say</h2>
          <div aria-hidden className="mt-3 h-1 w-12 rounded-full" style={{ backgroundColor: accent }} />
          {hasTestimonials && (
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {testimonials.map((t, i) => (
                <li key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <blockquote className="text-base text-white/85">&ldquo;{t.quote}&rdquo;</blockquote>
                  {t.author && <p className="mt-3 text-sm text-white/50">— {t.author}</p>}
                </li>
              ))}
            </ul>
          )}
          {hasRatings && (
            <div className="mt-6">
              <p className="text-lg font-semibold">
                <span className="text-yellow-300">★</span> {ratingSummary.average}
                <span className="ml-2 text-sm font-normal text-white/50">{ratingSummary.count} rating{ratingSummary.count === 1 ? '' : 's'} from attendees</span>
              </p>
              {ratingSummary.comments?.length > 0 && (
                <ul className="mt-4 space-y-3">
                  {ratingSummary.comments.map((c, i) => (
                    <li key={i} className="rounded-2xl border border-white/10 p-4">
                      <Stars n={c.rating} />
                      <p className="mt-2 text-sm text-white/80">{c.comment}</p>
                      {c.author && <p className="mt-2 text-xs text-white/45">— {c.author}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {hasPast && (
        <section aria-label="Past events">
          <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <summary className="cursor-pointer text-base font-semibold">Past events <span className="ml-2 text-sm font-normal text-white/45">({pastEvents.length})</span></summary>
            <ul className="mt-4 divide-y divide-white/10">
              {pastEvents.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="text-white/85">{e.name}</span>
                  <span className="shrink-0 text-white/45">{e.dateLabel}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  )
}
