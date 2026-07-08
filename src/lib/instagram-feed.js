// Instagram feed for the public events-page strip (EVENTS-IG.1).
// Graph media → cache rows, thumbnail re-host, per-location sync.

const GRAPH = 'https://graph.facebook.com/v21.0'
const CAPTION_MAX = 140

/**
 * Shape Graph media items into cache-row candidates. Pure. `image_url` is the
 * transient IG CDN URL the sync re-hosts; rows with no usable image are dropped.
 * @param {Array<object>} items
 * @returns {Array<{ig_media_id,media_type,is_reel,permalink,caption,image_url,posted_at}>}
 */
export function normalizeIgMedia(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id && it.permalink)
    .map((it) => {
      const isReel = it.media_product_type === 'REELS' || it.media_type === 'VIDEO'
      let caption = typeof it.caption === 'string' ? it.caption : null
      if (caption && caption.length > CAPTION_MAX) caption = caption.slice(0, CAPTION_MAX - 1).trimEnd() + '…'
      const image_url = it.media_type === 'VIDEO' ? (it.thumbnail_url || null) : (it.media_url || null)
      return {
        ig_media_id: String(it.id),
        media_type: it.media_type || 'IMAGE',
        is_reel: isReel,
        permalink: it.permalink,
        caption,
        image_url,
        posted_at: it.timestamp || null,
      }
    })
    .filter((r) => r.image_url)
}

const MEDIA_FIELDS = 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,caption,timestamp'

/**
 * Fetch + normalize the latest media for a connected IG account.
 * Throws on a Graph/HTTP error so the caller can keep the last-good cache.
 * @param {{external_account_id:string, access_token:string}} connection
 * @param {{limit?:number, fetchImpl?:Function}} [opts]
 */
export async function fetchIgMedia(connection, { limit = 12, fetchImpl = fetch } = {}) {
  const igId = connection?.external_account_id
  const token = connection?.access_token
  if (!igId || !token) throw new Error('instagram-feed: connection missing external_account_id/access_token')
  const url = `${GRAPH}/${igId}/media?fields=${MEDIA_FIELDS}&limit=${limit}&access_token=${encodeURIComponent(token)}`
  const res = await fetchImpl(url)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`instagram-feed graph ${res.status}: ${json?.error?.message || 'unknown'}`)
  return normalizeIgMedia(json?.data || [])
}

/**
 * Fetch the account's @username (for the "Follow" header). Best-effort: returns
 * null on any error — the strip still renders without it.
 */
export async function fetchIgUsername(connection, { fetchImpl = fetch } = {}) {
  const igId = connection?.external_account_id
  const token = connection?.access_token
  if (!igId || !token) return null
  try {
    const res = await fetchImpl(`${GRAPH}/${igId}?fields=username&access_token=${encodeURIComponent(token)}`)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return null
    return json?.username || null
  } catch {
    return null
  }
}
