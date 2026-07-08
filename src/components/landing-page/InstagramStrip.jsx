'use client'

// Public events-page Instagram strip (EVENTS-IG.1). A horizontal scroll-snap
// carousel of the studio's latest posts/reels. Tiles link out to Instagram.
// Renders nothing when there are no posts. Dark landing theme (lp-*).

export default function InstagramStrip({ posts, username, profileUrl }) {
  if (!posts || posts.length === 0) return null
  const handle = username ? `@${username}` : 'Instagram'
  const href = profileUrl || (username ? `https://instagram.com/${username}` : null)

  return (
    <section className="w-full py-12">
      <div className="flex items-center justify-between mb-5 px-1">
        <h2 className="text-xl font-semibold tracking-tight text-white">Follow along</h2>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm text-white/70 hover:text-white transition">
            {handle} →
          </a>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {posts.map((p) => (
          <a
            key={p.id}
            href={p.permalink}
            target="_blank"
            rel="noopener noreferrer"
            data-reel={p.is_reel ? 'true' : 'false'}
            className="relative shrink-0 snap-start w-40 h-40 sm:w-48 sm:h-48 rounded-xl overflow-hidden bg-white/5 border border-white/10 group"
          >
            <img src={p.thumb_url} alt={p.caption || 'Instagram post'} loading="lazy" className="w-full h-full object-cover transition duration-300 group-hover:scale-105" />
            {p.is_reel && (
              <span className="absolute top-2 right-2 grid place-items-center w-6 h-6 rounded-full bg-black/50 backdrop-blur">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
              </span>
            )}
          </a>
        ))}
      </div>
    </section>
  )
}
