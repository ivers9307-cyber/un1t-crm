// Instagram feed for the public events-page strip (EVENTS-IG.1).
// Graph media → cache rows, thumbnail re-host, per-location sync.

// Instagram Login API host (IG-LOGIN) — connections hold Instagram User
// tokens, which only work on graph.instagram.com (media reads included).
const GRAPH = 'https://graph.instagram.com/v25.0'
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

const BUCKET = 'instagram-feed'

async function rehostThumb({ db, locationId, post, fetchImpl }) {
  const res = await fetchImpl(post.image_url)
  if (!res.ok) throw new Error(`thumb fetch ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const path = `${locationId}/${post.ig_media_id}.jpg`
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error(`thumb upload: ${error.message}`)
  return path
}

/**
 * Sync ONE location's IG feed: fetch latest media (+username), re-host thumbs,
 * upsert rows, prune stale. Throws only on a Graph fetch error (caller keeps
 * last-good). Empty (non-error) response = no writes, no prune.
 * @param {{db:object, connection:object, fetchImpl?:Function}} args
 * @returns {Promise<{synced:number}>}
 */
export async function syncLocationIgFeed({ db, connection, fetchImpl = fetch }) {
  const locationId = connection.location_id
  const posts = await fetchIgMedia(connection, { fetchImpl })      // throws → keep last-good
  if (posts.length === 0) return { synced: 0 }                     // never wipe on empty
  const username = await fetchIgUsername(connection, { fetchImpl })
  const now = new Date().toISOString()
  const keptIds = []
  for (const post of posts) {
    let thumb_path
    try {
      thumb_path = await rehostThumb({ db, locationId, post, fetchImpl })
    } catch (e) {
      console.error(`[instagram-feed] rehost ${locationId}/${post.ig_media_id}: ${e.message}`)
      continue
    }
    await db.from('instagram_feed_posts').upsert({
      location_id: locationId,
      ig_media_id: post.ig_media_id,
      ig_username: username,
      media_type: post.media_type,
      is_reel: post.is_reel,
      permalink: post.permalink,
      caption: post.caption,
      thumb_path,
      posted_at: post.posted_at,
      fetched_at: now,
    }, { onConflict: 'location_id,ig_media_id' })
    keptIds.push(post.ig_media_id)
  }
  // Prune ONLY rows for posts IG no longer returns — keyed on the ids IG
  // returned this run (`posts`), NOT on keptIds. A post whose re-host merely
  // failed this run is still in `posts`, so its last-good row is preserved;
  // if EVERY re-host blips, keptIds is empty but returnedIds still covers them,
  // so nothing is wrongly wiped (keep-last-good holds).
  const returnedIds = posts.map((p) => p.ig_media_id)
  const { data: existing } = await db.from('instagram_feed_posts').select('ig_media_id').eq('location_id', locationId)
  const stale = (existing || []).map((r) => r.ig_media_id).filter((id) => !returnedIds.includes(id))
  if (stale.length > 0) await db.from('instagram_feed_posts').delete().eq('location_id', locationId).in('ig_media_id', stale)
  return { synced: keptIds.length }
}
