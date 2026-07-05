// STUDIO-HUB.1 — mobile TV-displays data helpers.
//
// tv_displays + tv_content are RLS-scoped to authenticated operators in
// the location (mig 160), so the mobile app reads/clears them directly
// via the Supabase client — exactly like the web TVAdmin does. We filter
// by the active location explicitly: RLS scopes a direct read to ALL the
// user's locations, and the active-location header only applies to the
// /api/* routes (not direct Supabase calls).
//
// Read + clear only on mobile. Content authoring (templates / image
// uploads, which need the canvas editor) stays on web.

import Constants from 'expo-constants'
import { supabase } from './supabase'
import { authHeaders } from './api'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl || ''

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
 * List the location's TVs with their current content (one tv_content
 * row per display, or none when the TV is idle).
 *
 * Two plain selects rather than a PostgREST embed: embeds are brittle
 * in this codebase (grant + multi-FK ambiguity surprises), and both
 * tables are independently authenticated-readable (the web TVAdmin
 * reads/writes tv_content via the same authenticated client), so a
 * separate fetch + client-side merge is the safe shape.
 */
export async function listTvDisplays(locationId) {
  if (!locationId) return { success: true, data: [] }
  const { data: displays, error } = await supabase
    .from('tv_displays')
    .select('id, label, token, active, rotation, location_id, created_at')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
  if (error) return { success: false, error: error.message }
  const rows = displays || []
  if (rows.length === 0) return { success: true, data: [] }

  const ids = rows.map((d) => d.id)
  const { data: contents } = await supabase
    .from('tv_content')
    .select('tv_display_id, source_type, source_ref, label, template_values, pushed_at')
    .in('tv_display_id', ids)
  const byDisplay = new Map((contents || []).map((c) => [c.tv_display_id, c]))

  return {
    success: true,
    data: rows.map((d) => ({ ...d, content: byDisplay.get(d.id) || null })),
  }
}

/**
 * Clear a TV back to the idle screen by deleting its content row.
 */
export async function clearTvContent(tvDisplayId) {
  const { error } = await supabase
    .from('tv_content')
    .delete()
    .eq('tv_display_id', tvDisplayId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Phase A: management (register / delete / orientation) ──────────
// All RLS-direct writes (tv_displays is authenticated-in-location CRUD).

/** Register a new TV at the location. A unique token is auto-generated. */
export async function registerTvDisplay(locationId, label) {
  if (!locationId || !label?.trim()) return { success: false, error: 'A label is required.' }
  const { error } = await supabase
    .from('tv_displays')
    .insert({ location_id: locationId, label: label.trim() })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Delete a TV. Its cast URL stops working (idempotent if already gone). */
export async function deleteTvDisplay(id) {
  const { error } = await supabase.from('tv_displays').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/** Set how the panel is physically hung — the cast picks it up on its next poll. */
export async function setTvRotation(id, rotation) {
  const { error } = await supabase.from('tv_displays').update({ rotation }).eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Phase B: push content (URL / photo / template) ─────────────────

/** The location's reusable templates (base image + fixed text zones). */
export async function listTvTemplates(locationId) {
  if (!locationId) return { success: true, data: [] }
  const { data, error } = await supabase
    .from('tv_templates')
    .select('id, name, base_image_path, zones')
    .eq('location_id', locationId)
    .order('name', { ascending: true })
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
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
    }
  }
  return seed
}

/**
 * Upload a picked image to the tv-content bucket via the (service-role)
 * upload route — the browser/mobile client can't write that bucket
 * directly. Multipart, so it bypasses api() (JSON-only) and uses
 * authHeaders() with no json flag (RN sets the FormData boundary).
 * Returns { success, path } — the storage path for a 'storage' push.
 */
export async function uploadTvImage({ uri, name, mimeType }, locationId, kind = 'content') {
  const headers = await authHeaders({ locationId })
  const form = new FormData()
  form.append('file', { uri, name: name || 'tv-image.jpg', type: mimeType || 'image/jpeg' })
  form.append('kind', kind === 'template' ? 'template' : 'content')
  form.append('location_id', locationId)
  let res
  try {
    res = await fetch(`${API_BASE}/api/admin/tv-displays/upload`, { method: 'POST', headers, body: form })
  } catch (e) {
    return { success: false, error: `Network error: ${e.message || e}` }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.success) return { success: false, error: json.error || `Upload failed (${res.status})` }
  return { success: true, path: json.path }
}

/**
 * Push content to a TV — upserts the single tv_content row (RLS-direct).
 * source_type: 'url' | 'storage' | 'template'. template_values carries
 * the per-zone text for a template push (null otherwise).
 */
export async function pushTvContent(tvDisplayId, { source_type, source_ref, label, template_values } = {}, pushedBy) {
  const { error } = await supabase.from('tv_content').upsert({
    tv_display_id: tvDisplayId,
    source_type,
    source_ref,
    label: label || null,
    template_values: template_values ?? null,
    pushed_at: new Date().toISOString(),
    pushed_by: pushedBy || null,
    triggered_by: pushedBy ? `manual:${pushedBy}` : 'manual',
  }, { onConflict: 'tv_display_id' })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Phase C: template authoring (create / edit / delete) ───────────

/** A single template by id (for the editor). */
export async function getTvTemplate(id) {
  const { data, error } = await supabase
    .from('tv_templates')
    .select('id, name, base_image_path, zones, location_id')
    .eq('id', id)
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, data }
}

/** Create or update a template. Pass `id` to update, omit to insert. */
export async function saveTvTemplate({ id, locationId, name, base_image_path, zones, createdBy } = {}) {
  if (!name?.trim()) return { success: false, error: 'A template name is required.' }
  if (!base_image_path) return { success: false, error: 'A base image is required.' }
  if (id) {
    const { error } = await supabase
      .from('tv_templates')
      .update({ name: name.trim(), base_image_path, zones: zones || [], updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return { success: false, error: error.message }
    return { success: true, id }
  }
  const { data, error } = await supabase
    .from('tv_templates')
    .insert({ location_id: locationId, name: name.trim(), base_image_path, zones: zones || [], created_by: createdBy || null })
    .select('id')
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, id: data?.id }
}

/** Delete a template. Any TV showing it falls back to idle. */
export async function deleteTvTemplate(id) {
  const { error } = await supabase.from('tv_templates').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
