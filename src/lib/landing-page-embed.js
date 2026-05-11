// landing-page-embed — parse a YouTube or Instagram URL into the
// provider + embeddable URL the public /welcome page renders into
// an <iframe>. Used by the welcome page render and (future) by the
// settings form for live-preview validation.
//
// Returns null when the URL doesn't match a known provider — caller
// renders nothing in that case rather than a broken iframe.

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
])
const IG_HOSTS = new Set([
  'instagram.com', 'www.instagram.com',
])

export function parseEmbed(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  let u
  try { u = new URL(rawUrl.trim()) } catch { return null }

  const host = u.hostname.toLowerCase()

  if (YT_HOSTS.has(host)) {
    // youtu.be/<id>
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0]
      return id ? { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` } : null
    }
    // youtube.com/watch?v=<id>
    const watchId = u.searchParams.get('v')
    if (watchId) return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${watchId}` }

    // youtube.com/embed/<id> | /shorts/<id> | /live/<id>
    const m = u.pathname.match(/^\/(embed|shorts|live)\/([A-Za-z0-9_-]+)/)
    if (m) return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${m[2]}` }

    return null
  }

  if (IG_HOSTS.has(host)) {
    // instagram.com/p/<id>/ | /reel/<id>/ | /tv/<id>/
    const m = u.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)
    if (m) {
      // IG's documented embed pattern. The trailing ?utm_source=ig_embed
      // isn't required but suppresses some redirect chatter.
      return { provider: 'instagram', embedUrl: `https://www.instagram.com/${m[1]}/${m[2]}/embed` }
    }
    return null
  }

  return null
}
