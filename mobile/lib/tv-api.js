// STUDIO-HUB.1 — mobile TV-displays data helpers.
//
// MEMBERWRITESWEEP.1f — every read and write goes through the session routes
// (/api/admin/tv-displays*, /api/admin/tv-templates*) via api(): tv_displays
// (web or mobile) at the TV's or template's own studio, pushes validated and
// stamped (pushed_by, created_by) on the server. Until then these helpers
// read and wrote tv_displays, tv_content and tv_templates straight from the
// phone's session under nothing but the membership policy (migs 160/190);
// mig 685 (PR 1g) closes the three tables to client sessions. Every function
// keeps its old { success, data | id | error } shape, so the screens are
// unchanged.
//
// Old server: an OTA can land before the web deploy that adds the routes.
// The server then answers an HTML 404 (routeNotDeployed), and only then the
// old direct path runs (./tv-api-legacy.js, deleted in 1g).
//
// Image bytes go through the signed-upload routes (uploadTvImage below,
// TVUPLOAD.1); public image URLs are the bucket's public read (tvImageUrl).

import Constants from 'expo-constants'
import { supabase } from './supabase'
import { api, authHeaders } from './api'
import { readPickedFiles, withTimeout, mimeResolver } from './upload-slots'
import * as legacy from './tv-api-legacy'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl || ''

/**
 * Is this api() answer "the route does not exist on this server"? Only the
 * transport envelope api() mints for a non-JSON body with status 404 (an
 * older deploy's HTML 404 page). A route's own JSON 404 ("TV not found") is
 * an answer, and a dropped connection has no status: neither falls back.
 */
export function routeNotDeployed(res) {
  return res?.transport === true && res?.status === 404
}

// The route's answer, or (older server only) the old direct path's.
async function viaRoute(path, options, legacyCall) {
  const res = await api(path, options)
  return routeNotDeployed(res) ? legacyCall() : res
}

const failed = (res, fallback) => ({ success: false, error: res?.error || fallback })
const done = (res, fallback) => (res?.success ? { success: true } : failed(res, fallback))
// A delete whose row is already gone (the route's JSON 404) is done: the old
// direct delete was idempotent too.
const deleted = (res, fallback) => (res?.success || (res?.status === 404 && !res?.transport) ? { success: true } : failed(res, fallback))
const enc = encodeURIComponent

/**
 * The public cast URL an operator pastes into UC Cast Pro for a TV.
 * (Display-only on mobile — the TV is configured once from the laptop.)
 */
export function castUrlForToken(token) {
  if (!token) return ''
  return `${API_BASE.replace(/\/$/, '')}/tv/cast/${token}`
}

// Screen-rotation options (clockwise degrees), matched 1:1 by the CSS
// rotate() the /tv/cast page applies (mig 189). Mirrors the web set.
export const TV_ORIENTATIONS = Object.freeze([
  { value: 0, label: 'Landscape' },
  { value: 90, label: 'Portrait (rotated right)' },
  { value: 270, label: 'Portrait (rotated left)' },
  { value: 180, label: 'Landscape (upside down)' },
])

export function orientationLabel(rotation) {
  return (TV_ORIENTATIONS.find((o) => o.value === (rotation ?? 0)) || TV_ORIENTATIONS[0]).label
}

/**
 * List the location's TVs with their current content (`content`: the TV's
 * one tv_content row, or null when it is idle). The route merges the two
 * reads and answers 500 if either fails, so an unreadable content row never
 * shows a TV as idle.
 */
export async function listTvDisplays(locationId) {
  if (!locationId) return { success: true, data: [] }
  const res = await viaRoute(`/api/admin/tv-displays?location_id=${enc(locationId)}`, { locationId },
    () => legacy.listTvDisplays(locationId))
  return res?.success ? { success: true, data: res.data || [] } : failed(res, 'Could not load the TVs.')
}

/** Clear a TV back to the idle screen. */
export async function clearTvContent(tvDisplayId) {
  const res = await viaRoute(`/api/admin/tv-displays/${enc(tvDisplayId)}/content`, { method: 'DELETE' },
    () => legacy.clearTvContent(tvDisplayId))
  return done(res, 'Could not clear the TV.')
}

// ── Phase A: management (register / delete / orientation) ──────────

/** Register a new TV at the location. A unique token is auto-generated. */
export async function registerTvDisplay(locationId, label) {
  if (!locationId || !label?.trim()) return { success: false, error: 'A label is required.' }
  const trimmed = label.trim()
  const res = await viaRoute('/api/admin/tv-displays', { method: 'POST', body: { location_id: locationId, label: trimmed }, locationId },
    () => legacy.registerTvDisplay(locationId, trimmed))
  return done(res, 'Could not register the TV.')
}

/** Delete a TV. Its cast URL stops working (idempotent if already gone). */
export async function deleteTvDisplay(id) {
  const res = await viaRoute(`/api/admin/tv-displays/${enc(id)}`, { method: 'DELETE' },
    () => legacy.deleteTvDisplay(id))
  return deleted(res, 'Could not delete the TV.')
}

/** Set how the panel is physically hung — the cast picks it up on its next poll. */
export async function setTvRotation(id, rotation) {
  const res = await viaRoute(`/api/admin/tv-displays/${enc(id)}`, { method: 'PATCH', body: { rotation } },
    () => legacy.setTvRotation(id, rotation))
  return done(res, 'Could not change the orientation.')
}

// ── Phase B: push content (URL / photo / template) ─────────────────

/** The location's reusable templates (base image + fixed text zones). */
export async function listTvTemplates(locationId) {
  if (!locationId) return { success: true, data: [] }
  const res = await viaRoute(`/api/admin/tv-templates?location_id=${enc(locationId)}`, { locationId },
    () => legacy.listTvTemplates(locationId))
  return res?.success ? { success: true, data: res.data || [] } : failed(res, 'Could not load the templates.')
}

/** Public URL for a tv-content bucket path (templates + uploaded images). */
export function tvImageUrl(path) {
  if (!path) return ''
  try {
    return supabase.storage.from('tv-content').getPublicUrl(path).data.publicUrl
  } catch {
    return ''
  }
}

/**
 * Seed per-zone push values from a template — copies each zone's saved
 * geometry + styling and the default text, so a mobile push (text-only
 * edit) renders identically to a web push with default styling.
 * Mirrors the web PushModal's pickTemplate seed.
 *
 * TV-REMEMBER.1 — `priorValues` (typically the TV's current
 * tv_content.template_values) is optionally overlaid on top of each
 * zone's defaults, so reopening the push modal for a TV already
 * showing this template starts from what's live rather than a blank
 * slate. Legacy prior values may be a plain string (text-only) rather
 * than an object — normalised the same way resolveZone() does. Zones
 * no longer on the template are dropped; zones added since the prior
 * push fall back to their template defaults. Pure function — no
 * change needed for either the mount-time or dropdown seeding path.
 */
export function seedTemplateValues(template, priorValues) {
  const seed = {}
  for (const z of template?.zones || []) {
    const prior = priorValues?.[z.id]
    const p = prior && typeof prior === 'object' ? prior : (prior != null ? { text: prior } : null)
    // TV-STYLE.6 — per-range style overrides survive a reopen. Only
    // seeded when the prior push (or the zone default) actually has
    // them: a legacy colour-run-only value must keep styleRuns UNSET
    // so the editor's first style edit knows to migrate colorRuns.
    // Mirrors the web seedZoneValues in TVAdmin.jsx.
    const styleRuns = Array.isArray(p?.styleRuns)
      ? p.styleRuns
      : (Array.isArray(z.styleRuns) ? z.styleRuns : null)
    seed[z.id] = {
      text: p?.text ?? z.defaultText ?? '',
      fontSize: p?.fontSize ?? z.fontSize ?? 6,
      fontWeight: p?.fontWeight ?? z.fontWeight ?? 700,
      color: p?.color || z.color || '#FFFFFF',
      align: p?.align || z.align || 'center',
      vAlign: p?.vAlign || z.vAlign || 'middle',
      uppercase: p?.uppercase ?? !!z.uppercase,
      lineHeight: p?.lineHeight ?? z.lineHeight ?? 1.15,
      x: p?.x ?? z.x ?? 0, y: p?.y ?? z.y ?? 0, width: p?.width ?? z.width ?? 100, height: p?.height ?? z.height ?? 100,
      colorRuns: Array.isArray(p?.colorRuns) ? p.colorRuns : (Array.isArray(z.colorRuns) ? z.colorRuns : []),
      ...(styleRuns ? { styleRuns } : {}),
    }
  }
  return seed
}

// TVUPLOAD.1 (C93) — the image types a TV takes (the tv-content bucket's
// list, src/lib/tv-media.js, which the phone cannot import). The picker's own
// type is trusted first; this is the fallback from the file name.
const resolveTvImageMime = mimeResolver({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
}, 'image/jpeg')

async function postJson(path, body, locationId, label) {
  const headers = await authHeaders({ locationId, json: true })
  const res = await withTimeout(fetch(`${API_BASE}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }), label)
  const json = await res.json().catch(() => ({ success: false, error: `Upload failed (${res.status})` }))
  return json || { success: false, error: `Upload failed (${res.status})` }
}

/**
 * Upload a picked image for a TV: a push image (kind 'content') or a
 * template's base image (kind 'template'). Returns { success, path }, the
 * storage path for a 'storage' push or tv_templates.base_image_path, or
 * { success: false, error }. Never throws.
 *
 * TVUPLOAD.1 (C93) — the bytes go straight to Storage. The old multipart
 * post to /api/admin/tv-displays/upload carried a `{uri}` file part, which
 * has not left the phone since Expo SDK 57 (the fetch rejects on the device,
 * no request is made). Now, as for issue photos and invoices:
 *   1. /api/admin/tv-displays/upload/sign mints a path + token (tv_displays
 *      at the TV's studio, the declared type and size checked);
 *   2. the ArrayBuffer (never a Blob: a zero-byte object on RN, see
 *      upload-bytes.js) is uploaded with that token, which is the only
 *      write a client may make on the bucket (tests/tv-content-bucket-guard);
 *   3. /api/admin/tv-displays/upload/finalise checks what Storage holds.
 * Each network step is time-boxed (withTimeout), so the caller's spinner
 * always clears.
 */
export async function uploadTvImage({ uri, name, mimeType }, locationId, kind = 'content') {
  const k = kind === 'template' ? 'template' : 'content'
  try {
    const read = await readPickedFiles(
      [{ uri, name: name || 'tv-image.jpg', mimeType }],
      { resolveMime: resolveTvImageMime, label: 'image' },
    )
    if (!read.ok) return { success: false, error: read.error }
    const file = read.files[0]

    const sign = await postJson('/api/admin/tv-displays/upload/sign', {
      kind: k, location_id: locationId, file_name: file.name, mime: file.mime, size: file.bytes.byteLength,
    }, locationId, 'Preparing the upload')
    if (sign.success !== true || !sign.path || !sign.token) {
      return { success: false, error: sign.error || 'Could not start the upload.' }
    }

    const { error: upErr } = await withTimeout(
      supabase.storage.from('tv-content').uploadToSignedUrl(sign.path, sign.token, file.bytes, { contentType: file.mime }),
      'Uploading the image',
    )
    if (upErr) return { success: false, error: `Upload failed: ${upErr.message || upErr}` }

    const fin = await postJson('/api/admin/tv-displays/upload/finalise', {
      kind: k, location_id: locationId, path: sign.path,
    }, locationId, 'Saving the upload')
    if (fin.success !== true || !fin.path) return { success: false, error: fin.error || 'Upload failed.' }
    return { success: true, path: fin.path }
  } catch (e) {
    return { success: false, error: `Network error: ${e?.message || e}` }
  }
}

/**
 * Push content to a TV: the route upserts its single tv_content row.
 * source_type: 'url' | 'storage' | 'template'. template_values carries the
 * per-zone text for a template push. The server stamps pushed_at, pushed_by
 * and triggered_by from the session and refuses a push the cast page may not
 * show (DECISION 4); `pushedBy` is kept for the call sites and used only by
 * the old-server fallback.
 */
export async function pushTvContent(tvDisplayId, { source_type, source_ref, label, template_values } = {}, pushedBy) {
  const body = {
    source_type,
    source_ref,
    label: label || null,
    ...(template_values === undefined ? {} : { template_values }),
  }
  const res = await viaRoute(`/api/admin/tv-displays/${enc(tvDisplayId)}/content`, { method: 'PUT', body },
    () => legacy.pushTvContent(tvDisplayId, { source_type, source_ref, label, template_values }, pushedBy))
  return done(res, 'Push failed.')
}

// ── Phase C: template authoring (create / edit / delete) ───────────

/** A single template by id (for the editor), with its studio (`location_id`). */
export async function getTvTemplate(id) {
  const res = await viaRoute(`/api/admin/tv-templates/${enc(id)}`, {}, () => legacy.getTvTemplate(id))
  return res?.success ? { success: true, data: res.data } : failed(res, 'Could not load the template.')
}

/**
 * Create or update a template. Pass `id` to update, omit to insert at
 * `locationId`. The server sets created_by from the session; `createdBy` is
 * kept for the call site and used only by the old-server fallback.
 */
export async function saveTvTemplate({ id, locationId, name, base_image_path, zones, createdBy } = {}) {
  if (!name?.trim()) return { success: false, error: 'A template name is required.' }
  if (!base_image_path) return { success: false, error: 'A base image is required.' }
  const fields = { name: name.trim(), base_image_path, zones: zones || [] }
  if (id) {
    const res = await viaRoute(`/api/admin/tv-templates/${enc(id)}`, { method: 'PUT', body: fields },
      () => legacy.saveTvTemplate({ id, ...fields }))
    return res?.success ? { success: true, id } : failed(res, 'Could not save the template.')
  }
  const res = await viaRoute('/api/admin/tv-templates', { method: 'POST', body: { location_id: locationId, ...fields }, locationId },
    () => legacy.saveTvTemplate({ locationId, ...fields, createdBy }))
  if (!res?.success) return failed(res, 'Could not save the template.')
  return { success: true, id: res.id ?? res.data?.id }
}

/** Delete a template. Any TV showing it falls back to idle (idempotent if already gone). */
export async function deleteTvTemplate(id) {
  const res = await viaRoute(`/api/admin/tv-templates/${enc(id)}`, { method: 'DELETE' },
    () => legacy.deleteTvTemplate(id))
  return deleted(res, 'Could not delete the template.')
}
