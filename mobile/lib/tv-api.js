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
    .select('tv_display_id, source_type, source_ref, label, pushed_at')
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
