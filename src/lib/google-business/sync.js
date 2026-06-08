// Google reviews sync. syncReviewsForLocation pages the v4 reviews endpoint,
// upserts by (location_id, google_review_id) WITHOUT touching `hidden` (so
// operator hides survive), and snapshots the aggregate onto the connection.

import { createServerClient } from '@/lib/supabase'
import { withFreshToken, listReviews } from './client'
import { normalizeReview } from './reviews'

const MAX_PAGES = 50 // 50 pages * 50/page = 2500 reviews — ample headroom

// Pure: flatten Google review pages → DB rows. Drops rating-0 (unspecified).
// Deliberately omits `hidden` so the upsert can't clobber operator state.
export function buildReviewRows(locationId, pages) {
  const now = new Date().toISOString()
  const rows = []
  for (const page of pages || []) {
    for (const r of page?.reviews || []) {
      const n = normalizeReview(r)
      if (!n.google_review_id || n.rating < 1) continue
      rows.push({
        location_id: locationId,
        google_review_id: n.google_review_id,
        rating: n.rating,
        comment: n.comment,
        author_name: n.author_name,
        author_photo_url: n.author_photo_url,
        review_time: n.review_time,
        reply_comment: n.reply_comment,
        synced_at: now,
      })
    }
  }
  return rows
}

// Sync one location. Returns { synced, total, average } or throws.
export async function syncReviewsForLocation(locationId) {
  const db = createServerClient()
  const { conn, accessToken } = await withFreshToken(locationId)
  if (!conn.location_resource) {
    throw new Error('Connection has no location selected yet.')
  }

  const pages = []
  let pageToken
  let aggregate = { averageRating: null, totalReviewCount: null }
  for (let i = 0; i < MAX_PAGES; i++) {
    const json = await listReviews(accessToken, conn.location_resource, pageToken)
    pages.push(json)
    if (aggregate.averageRating == null && json.averageRating != null) {
      aggregate = { averageRating: json.averageRating, totalReviewCount: json.totalReviewCount ?? null }
    }
    pageToken = json.nextPageToken
    if (!pageToken) break
  }

  const rows = buildReviewRows(locationId, pages)
  if (rows.length > 0) {
    const { error } = await db
      .from('google_reviews')
      .upsert(rows, { onConflict: 'location_id,google_review_id' })
    if (error) throw new Error(`Upsert failed: ${error.message}`)
  }

  const { error: connErr } = await db
    .from('google_business_connections')
    .update({
      average_rating: aggregate.averageRating,
      total_review_count: aggregate.totalReviewCount,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq('id', conn.id)
  if (connErr) throw new Error(`Aggregate update failed: ${connErr.message}`)

  return { synced: rows.length, total: aggregate.totalReviewCount, average: aggregate.averageRating }
}

// Sync every connected location. Best-effort per location — records sync_error
// on the connection but never throws so one bad location can't abort the cron.
export async function syncAllLocations() {
  const db = createServerClient()
  const { data: conns } = await db
    .from('google_business_connections')
    .select('location_id')
    .not('location_resource', 'is', null)

  const results = []
  for (const c of conns || []) {
    try {
      const r = await syncReviewsForLocation(c.location_id)
      results.push({ location_id: c.location_id, ...r })
    } catch (e) {
      results.push({ location_id: c.location_id, error: e?.message || String(e) })
      try {
        await db.from('google_business_connections')
          .update({ sync_error: e?.message || String(e) })
          .eq('location_id', c.location_id)
      } catch { /* best-effort */ }
    }
  }
  return results
}
