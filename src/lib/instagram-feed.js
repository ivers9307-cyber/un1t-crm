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
