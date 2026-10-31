// MEDIALIB.1 — the page editor's media library: every video or image the
// organisation's pages have already uploaded to the public 'branding' bucket,
// so an operator can reuse a clip instead of uploading it again.
//
// A READER of the bucket, never a writer (tests/branding-bucket-guard.test.js
// pins the writers; this module adds none and needs no storage policy: it
// runs on the service role from /api/landing-pages/media).
//
// What is listed, and for whom (service role bypasses RLS, so the scope is
// decided here, the same way the pages API decides it):
//   * `pages/<page id>/`         for every landing_pages row canViewPage admits
//                                 (the new editor's uploads, PAGES.1);
//   * `landing-page/<studio>/`   for every studio that is the primary of such
//                                 a page (the legacy per-studio editor's
//                                 uploads). Every studio has a kind='studio'
//                                 page whose primary is itself, and viewing a
//                                 one-studio page is exactly "holds
//                                 landing_page there" (or org admin / master),
//                                 so no second permission check is needed.
// A page outside the caller's view contributes nothing, so its files cannot
// be enumerated through this list.
//
// Each item carries the public URL, the stored name, size, created time, the
// page (or studio) it came from and, for a video, the poster stored next to
// it: uploads are UUID-named, so the pairing is read from the blocks of the
// same viewable pages (a block or item holding both video_url and
// poster_url; a hero's image_url is its video's poster). A failed read
// (pages or a folder) throws PageReadError: the route answers 503, never a
// shorter list.

import { canViewPage, PageReadError, PAGE_COLUMNS } from '@/lib/landing-pages'
import { adminOrganizationIds } from '@/lib/org-admin'

export const MEDIA_KINDS = Object.freeze(['video', 'image'])

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])
// A folder can hold at most this many objects per list call; a page's media
// folder holds a few dozen at most, and the legacy studio folders under 200.
const LIST_LIMIT = 1000
const READ_PAGE_SIZE = 1000

const isMaster = (user) => Boolean(user && (user.isMaster || user.role === 'master'))

function viewerOrgIds(user) {
  const ids = new Set(adminOrganizationIds(user))
  for (const l of user?.locations || []) if (l?.organization_id) ids.add(l.organization_id)
  return [...ids]
}

/** 'video' | 'image' | null for a stored object name (by extension, then by the stored MIME type). */
export function mediaKindOf(name, mimetype = null) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  if (VIDEO_EXT.has(ext)) return 'video'
  if (IMAGE_EXT.has(ext)) return 'image'
  const mt = String(mimetype || '').toLowerCase()
  if (mt.startsWith('video/')) return 'video'
  if (mt.startsWith('image/')) return 'image'
  return null
}

/**
 * video URL → poster URL, read from a page's blocks: any object holding both
 * `video_url` and `poster_url` (campaign funnel, video testimonial items), or
 * a hero holding `video_url` and `image_url`. The first poster seen for a
 * video wins. Exported for its test.
 */
export function posterPairsFromBlocks(blocks, into = new Map()) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    const video = typeof node.video_url === 'string' ? node.video_url : ''
    if (video) {
      const poster = typeof node.poster_url === 'string' && node.poster_url
        ? node.poster_url
        : (node.type === 'hero' && typeof node.image_url === 'string' ? node.image_url : '')
      if (poster && !into.has(video)) into.set(video, poster)
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v)
  }
  walk(blocks)
  return into
}

async function readViewablePages(db, user) {
  const orgIds = isMaster(user) ? null : viewerOrgIds(user)
  if (orgIds && orgIds.length === 0) return []
  const out = []
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    let q = db.from('landing_pages').select(PAGE_COLUMNS)
    if (orgIds) q = q.in('organization_id', orgIds)
    const { data, error } = await q.order('organization_id').order('slug').range(from, from + READ_PAGE_SIZE - 1)
    if (error) throw new PageReadError('Could not read the pages', error)
    const rows = Array.isArray(data) ? data : []
    out.push(...rows)
    if (rows.length < READ_PAGE_SIZE) break
  }
  return out.filter((p) => canViewPage(user, p))
}

async function listFolder(db, prefix) {
  const { data, error } = await db.storage.from('branding').list(prefix, {
    limit: LIST_LIMIT,
    sortBy: { column: 'created_at', order: 'desc' },
  })
  if (error) throw new PageReadError(`Could not read the media folder ${prefix}`, error)
  // A sub-folder lists as an entry with no id; only files are media.
  return (Array.isArray(data) ? data : []).filter((o) => o && o.name && o.id !== null && o.id !== undefined)
}

/**
 * The media library for a caller: `{ items }`, newest first, one entry per
 * URL, kept to `kind` when given ('video' | 'image').
 *
 * @param {object} db  the service-role client (storage + landing_pages)
 * @param {object} user  getCurrentUser()'s user
 * @param {{ kind?: 'video'|'image'|null }} [opts]
 */
export async function listLandingMediaForUser(db, user, { kind = null } = {}) {
  if (!user) return { items: [] }
  const pages = await readViewablePages(db, user)
  if (!pages.length) return { items: [] }

  const posters = new Map()
  for (const p of pages) posterPairsFromBlocks(p.blocks, posters)

  // The folders, each with the page (or studio) it stands for.
  const folders = []
  const seenStudios = new Set()
  for (const p of pages) {
    folders.push({ prefix: `pages/${p.id}`, page_id: p.id, page_title: p.title || p.slug || null, location_id: p.primary_location_id || null })
  }
  for (const p of pages) {
    const loc = p.primary_location_id
    if (!loc || seenStudios.has(loc)) continue
    seenStudios.add(loc)
    // The legacy folder reads as its studio page (the studio's own page).
    const studioPage = pages.find((x) => x.kind === 'studio' && x.primary_location_id === loc) || p
    folders.push({ prefix: `landing-page/${loc}`, page_id: studioPage.id, page_title: studioPage.title || studioPage.slug || null, location_id: loc, legacy: true })
  }

  const items = []
  const seenUrls = new Set()
  for (const folder of folders) {
    const objects = await listFolder(db, folder.prefix)
    for (const o of objects) {
      const k = mediaKindOf(o.name, o.metadata?.mimetype)
      if (!k || (kind && k !== kind)) continue
      const path = `${folder.prefix}/${o.name}`
      const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
      const url = urlData?.publicUrl
      if (!url || seenUrls.has(url)) continue
      seenUrls.add(url)
      items.push({
        url,
        path,
        name: o.name,
        kind: k,
        size: Number(o.metadata?.size) || null,
        created_at: o.created_at || null,
        page_id: folder.page_id,
        page_title: folder.page_title,
        location_id: folder.location_id,
        poster_url: k === 'video' ? (posters.get(url) || null) : null,
      })
    }
  }
  items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  return { items }
}
